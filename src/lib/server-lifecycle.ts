import type { Request, Response, NextFunction, RequestHandler } from "express";
type Owner = { close(): Promise<void> };
type Stage = (req: Request, res: Response) => Promise<boolean>;

/** Actual local producer settlement, NOT a replica/external/kernel-I/O fence. */
export class ServerLifecycle {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly owners = new Map<Owner, Promise<void> | undefined>();
  private ownerFailures = 0;
  private handlerFailures = 0;
  private stopping?: Promise<unknown>;
  constructor(private readonly expiry: { stopAndSettle(): Promise<unknown> },
    private readonly activity: { settle(): Promise<unknown> }) {}
  get accepting(): boolean { return !this.closed; }
  get retainedOwners(): number { return this.owners.size; }
  get activeHandlers(): number { return this.pending.size; }

  run<T>(work: () => T | PromiseLike<T>): Promise<T> | null {
    if (this.closed) return null;
    // Retain before user code, including sync throw/reentry.
    const task = Promise.resolve().then(work);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => {
      this.handlerFailures++; this.pending.delete(task);
    });
    return task;
  }
  own(owner: Owner): void {
    if (this.closed) throw Error("Server admission closed");
    if (!this.owners.has(owner)) this.owners.set(owner, undefined);
  }
  closeOwner(owner: Owner): Promise<void> {
    const existing = this.owners.get(owner);
    if (existing) return existing;
    if (!this.owners.has(owner)) return Promise.resolve();
    let resolve!: () => void;
    const retained = new Promise<void>(r => { resolve = r; });
    this.owners.set(owner, retained);
    const finish = () => { this.owners.delete(owner); resolve(); };
    try { void owner.close().then(finish, () => { this.ownerFailures++; finish(); }); }
    catch { this.ownerFailures++; finish(); }
    return retained;
  }
  socket<A extends unknown[]>(handler: (...args: A) => unknown,
    rejected: (...args: A) => void, onError: (error: unknown) => void) {
    return (...args: A): void => {
      const task = this.run(() => handler(...args));
      if (!task) { rejected(...args); return; }
      void task.catch(onError);
    };
  }
  stopAndSettle(): Promise<unknown> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    this.stopping = new Promise((yes, no) => { resolve = yes; reject = no; });
    let expiry: Promise<unknown>;
    try { expiry = this.expiry.stopAndSettle(); }
    catch (error) { expiry = Promise.reject(error); }
    const expiryResult = Promise.allSettled([expiry]);
    for (const owner of this.owners.keys()) this.closeOwner(owner);
    void (async () => {
      while (this.pending.size || this.owners.size) {
        await Promise.allSettled([...this.pending,
          ...[...this.owners.values()].filter((p): p is Promise<void> => !!p)]);
      }
      const stoppedExpiry = await expiryResult;
      // Producers cannot enqueue after activity settlement.
      const activity = await this.activity.settle();
      return { ownerFailures: this.ownerFailures, handlerFailures: this.handlerFailures,
        expiry: stoppedExpiry[0], activity };
    })().then(resolve, reject);
    return this.stopping;
  }
}

/** Callback parser/storage settlement; never response finish/close. */
export function callbackStage(handler: RequestHandler): Stage {
  return (req, res) => new Promise((resolve, reject) => {
    handler(req, res, error => error ? reject(error) : resolve(true));
  });
}
/** Application middleware: await actual return AND next decision. */
export function handlerStage(handler: (req: Request, res: Response,
  next: NextFunction) => unknown): Stage {
  return async (req, res) => {
    let advance = false, failure: unknown;
    await handler(req, res, error => { advance = true; failure = error; });
    if (failure) throw failure;
    return advance;
  };
}
export function trackedHttp(lifecycle: ServerLifecycle, ...stages: Stage[]): RequestHandler {
  return (req, res, next) => {
    const task = lifecycle.run(async () => {
      for (const stage of stages) if (!await stage(req, res)) return;
    });
    if (!task) { res.status(503).json({ error: "Server is draining" }); return; }
    void task.catch(next);
  };
}

