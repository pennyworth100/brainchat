import { ResumeBindings, type ResumeBinding } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import { hashResumeToken, type ResumeCredential, type ResumeIdentity, type ResumeStore } from "./resume-store";

type Request = { credential: ResumeCredential; expectedGeneration: number; operationId: string };
type Cleanup = () => Promise<void>;
type Limits = { capacity: ResumeCapacity; timeoutMs: number; onLateError: (error: unknown) => void };

// PRIVATE seam: create exactly ONCE per physical server connection, never per
// request. Do not mix ordinary joins or direct bindings on that connection.
// A failed/uncertain attempt is terminal for this incarnation; reconnect with a
// new server ID to explicitly recover. No automatic CAS replay or public use.
export class ResumeAdmission {
  private closed = false;
  private key: string | undefined;
  private flight: Promise<ResumeBinding | null> | undefined;
  private work: Promise<ResumeBinding | null> | undefined;
  private deadline = Infinity;
  private readonly limits: Limits | undefined;
  private binding: ResumeBinding | undefined;
  private cleanup: Cleanup | undefined;

  constructor(private readonly store: Pick<ResumeStore, "advanceGeneration">,
    private readonly bindings: ResumeBindings, private readonly transportId: string,
    private readonly connected: () => boolean,
    // Preparation must not publish history/presence or grant outbound access.
    // It returns an EXACT lease cleanup; if it throws it must clean partial work.
    private readonly prepare: (identity: ResumeIdentity) => Promise<Cleanup>, limits?: Limits) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(transportId)) throw Error("Invalid transport incarnation");
    if (limits) {
      if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 2_147_483_647) {
        throw Error("Invalid admission deadline");
      }
      this.limits = { ...limits };
    }
  }

  private live() {
    try { return !this.closed && performance.now() < this.deadline && this.connected(); } catch { return false; }
  }

  // Distinguish the reserved attempt from a non-destructive invalid/conflicting
  // request. Promise identity is server-owned and must be checked synchronously.
  ownsAttempt(flight: Promise<ResumeBinding | null>): boolean {
    return flight === this.flight;
  }

  admit(request: Request): Promise<ResumeBinding | null> {
    if (!this.live()) return Promise.resolve(null);
    const credential = { ...request.credential };
    const tokenHash = hashResumeToken(credential.token);
    if (!tokenHash) return Promise.resolve(null);
    const { expectedGeneration, operationId } = request;
    const key = JSON.stringify([credential.sessionId, credential.roomId, tokenHash,
      expectedGeneration, operationId]);
    if (this.flight) {
      if (key !== this.key || (this.binding && !this.bindings.isCurrent(this.binding))) {
        return Promise.resolve(null);
      }
      return this.flight; // including rejection: uncertainty never reruns DB
    }
    // Reserve synchronously, BEFORE invoking any asynchronous or reentrant hook.
    this.key = key;
    const release = this.limits?.capacity.acquire();
    if (release === null) {
      this.closed = true; // overload is terminal, never queued or automatically retried
      return this.flight = Promise.resolve(null);
    }
    if (this.limits) this.deadline = performance.now() + this.limits.timeoutMs;
    this.work = Promise.resolve().then(async () => {
      if (!this.live()) return null;
      const identity = await this.store.advanceGeneration(credential,
        expectedGeneration, operationId, this.transportId);
      if (!identity || !this.live() || identity.sessionId !== credential.sessionId ||
          identity.roomId !== credential.roomId || identity.generation !== expectedGeneration + 1) return null;
      try {
        const binding = await this.bindings.activate(identity, this.transportId, async () => {
          this.cleanup = await this.prepare(identity);
        }, () => this.live());
        // activate can finish before this continuation resumes: recheck authority.
        if (!binding || !this.live() || !this.bindings.isCurrent(binding)) {
          if (binding) this.bindings.detach(binding);
          await this.dispose();
          return null;
        }
        this.binding = binding;
        return binding;
      } catch (error) {
        await this.dispose();
        throw error;
      }
    });
    if (!this.limits) return this.flight = this.work;
    const limits = this.limits;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        // close fences synchronously, but does not cancel CAS or release capacity.
        void this.close().catch(error => this.reportLate(error));
        resolve(null);
      }, limits.timeoutMs);
    });
    const settled = this.work.then(value => {
      clearTimeout(timer); release?.();
      // An admitted binding is governed by DB expiry, not the admission deadline.
      if (value) this.deadline = Infinity;
      return value;
    }, error => {
      clearTimeout(timer); release?.();
      if (timedOut) this.reportLate(error);
      throw error;
    });
    return this.flight = Promise.race([settled, timeout]);
  }

  private reportLate(error: unknown) {
    try { this.limits?.onLateError(error); }
    catch (reportError) { console.error("Resume late error reporter failed", reportError); }
  }

  private async dispose() {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup) await cleanup();
  }

  async close(): Promise<void> {
    // Permanent fence is synchronous, even if DB/prepare has not completed.
    this.closed = true;
    if (this.binding) this.bindings.detach(this.binding);
    if (this.work) {
      // Preserve failure to the original caller, but still release acquired lease.
      try { await this.work; } catch { /* no replay */ }
    }
    await this.dispose();
  }
}
