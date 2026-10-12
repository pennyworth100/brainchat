import { browserLeaseJournal, type LeaseChange, type LeaseCheckpoint } from "./browser-lease-journal";
import { createBrowserResumeController, type BrowserLease } from "./browser-resume-controller";

type Core = ReturnType<typeof createBrowserResumeController>;
type Ticket = Parameters<Core["accept"]>[0];
export type LeaseStorage = (scope: string,
  mutation?: { expectedRevision: string | null; change: LeaseChange }) => Promise<LeaseCheckpoint | undefined>;

/**
 * PRIVATE composition seam. Caller must use one object per physical socket
 * incarnation, await admission BEFORE emitting, and authenticate the negotiated
 * protocol server-side. No public wiring, fallback, pending-message import,
 * receipt lookup or automatic retransmission. Reload never imports READY.
 */
export async function createBrowserDurableResume(scope: string, storage: LeaseStorage = browserLeaseJournal,
  newKey = () => crypto.randomUUID(), now = Date.now) {
  let saved = structuredClone(await storage(scope));
  const core = createBrowserResumeController(newKey, now, 32, "publication-cut");
  if (saved) core.restore(saved);
  let busy = false, failed = false, epoch = 0;
  let active: object | null = null;
  const persist = async (change: LeaseChange) => {
    const next = await storage(scope, { expectedRevision: saved?.revision ?? null, change });
    if (!next) throw Error("Missing committed session");
    saved = structuredClone(next);
  };
  const ordered = async <T>(physical: object, work: () => Promise<T>): Promise<T> => {
    if (failed || busy) throw Error("Session persistence unavailable or busy");
    busy = true;
    const started = epoch;
    try {
      const result = await work();
      if (started !== epoch) throw Error("Physical connection changed during persistence");
      return result;
    } catch (error) {
      failed = true;
      core.disconnect(active ?? physical);
      active = null; epoch++;
      throw error;
    } finally { busy = false; }
  };
  const begin = (kind: "resume" | "transfer", physical: object) => ordered(physical, async () => {
    const ticket = kind === "resume" ? core.beginResume(physical) : core.beginTransfer(physical);
    active = physical;
    await persist({ kind, operationId: ticket.kind === "transfer" ? ticket.transferOperationId : ticket.operationId });
    return { ticket, lease: Object.freeze({ ...saved!.lease! }) };
  });
  return {
    beginJoin: (roomId: string, username: string, physical: object) => ordered(physical, async () => {
      if (saved) throw Error("Existing session journal cannot be replaced");
      const ticket = core.beginJoin(roomId, username, physical);
      active = physical;
      await persist({ kind: "join", roomId, username, operationId: ticket.operationId });
      return ticket;
    }),
    beginResume: (physical: object) => begin("resume", physical),
    beginTransfer: (physical: object) => begin("transfer", physical),
    accept: (ticket: Ticket, physical: object, value: BrowserLease) => ordered(physical, async () => {
      // Core validates exact ticket/incarnation BEFORE durable mutation. Freeze
      // caller input before the await; fullsync is unavailable until commit.
      const grant = structuredClone(value);
      const sync = core.accept(ticket, physical, grant);
      await persist({ kind: "accept", lease: grant });
      return sync;
    }),
    disconnect(physical: object) {
      if (physical === active) { epoch++; active = null; }
      core.disconnect(physical);
    },
    reject: core.reject,
    // No legacy finishSync escape hatch. Publication must confirm and maintain
    // its authenticated cut before the existing controller can grant readiness.
    publicationSnapshot: core.publicationSnapshot,
    stagePublication: core.stagePublication,
    publicationAck: core.publicationAck,
    confirmPublication: core.confirmPublication,
    receivePublication: core.receivePublication,
    startPublication: core.startPublication,
    status: () => ({ ...core.status(), persistenceFailed: failed }),
  };
}
