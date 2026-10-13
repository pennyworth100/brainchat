import { isValidRoomId } from "./room-id";
import { validateLeaseCheckpoint, type LeaseCheckpoint } from "./browser-lease-journal";
import { createBrowserPublicationPump, type PublicationClock } from "./browser-publication-pump";
import { createBrowserPublicationJournal } from "./browser-publication-journal";
import type { UploadAuthority } from "./upload-authority";
import { createBrowserSnapshotWindow, type SnapshotCompletion } from "./browser-resume-snapshot";
import { createBrowserPublicationSnapshot, type PublicationCompletion } from "./browser-publication-snapshot";

export type BrowserLease = Readonly<{
  roomId: string; username: string; sessionId: string; token: string;
  generation: number; expiresAt: number;
}>;
type Phase = "empty" | "joining" | "syncing" | "ready" | "offline" | "uncertain" | "blocked";
type CasAttempt = Readonly<{ kind: "join" | "resume"; operationId: string; expectedGeneration: number }>;
type TransferAttempt = Readonly<{ kind: "transfer"; originalOperationId: string; expectedGeneration: number;
  transferOperationId: string }>;
type Attempt = CasAttempt | TransferAttempt;
type SyncAttempt = Readonly<{ sessionId: string; generation: number; requestId: string }>;
type Operation = Readonly<{ clientMessageId: string; kind: "message" | "image" | "file"; payloadHash: string }>;
const validKey = (key: string) => /^[A-Za-z0-9_-]{16,128}$/.test(key);

/**
 * Private migration core; NOT wired to the public browser/server yet.
 * Memory-only, no storage, transport effects, legacy fallback or automatic CAS.
 * A transport object must identify one physical connection incarnation.
 */
export function createBrowserResumeController(
  newKey = () => crypto.randomUUID(), now = Date.now, maxPending = 32,
  syncProtocol: "legacy-window" | "publication-cut" = "legacy-window",
) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw Error("Invalid pending limit");
  if (!["legacy-window", "publication-cut"].includes(syncProtocol)) throw Error("Invalid synchronization protocol");
  let phase: Phase = "empty";
  let roomId = "", username = "";
  let lease: BrowserLease | null = null;
  let transport: object | null = null;
  let attempt: Attempt | null = null;
  let lostCas: { ticket: CasAttempt; physical: object } | null = null;
  let syncAttempt: SyncAttempt | null = null;
  let snapshot: ReturnType<typeof createBrowserSnapshotWindow> | null = null;
  let publication: ReturnType<typeof createBrowserPublicationSnapshot> | null = null;
  let journal: ReturnType<typeof createBrowserPublicationJournal> | null = null;
  let pump: ReturnType<typeof createBrowserPublicationPump> | null = null;
  const stopPolling = () => { pump?.cancel(); pump = null; };
  const block = () => { stopPolling(); phase = "blocked"; };
  const pending = new Map<Operation, { sent: boolean }>();
  // Never recycle a key during this logical owner's lifetime, even after ACK.
  const usedKeys = new Set<string>();
  const freshKey = () => {
    if (usedKeys.size >= 10_000) throw Error("Session operation capacity reached");
    const key = newKey();
    if (!validKey(key) || usedKeys.has(key)) throw Error("Invalid or reused operation key");
    usedKeys.add(key);
    return key;
  };
  const live = () => {
    if (!lease || lease.expiresAt <= now()) {
      block();
      throw Error("Session expired");
    }
    return lease;
  };
  const ready = () => {
    const current = live();
    if (phase === "ready" && syncProtocol === "publication-cut" && !pump?.live()) block();
    if (phase !== "ready" || !transport) throw Error("Session is not synchronized");
    return current;
  };
  const owns = (operation: Operation) => {
    const record = pending.get(operation);
    if (!record) throw Error("Operation owner changed");
    return record;
  };
  const accept = (ticket: Attempt, physical: object, value: BrowserLease) => {
    if (ticket !== attempt || physical !== transport ||
        (phase !== "joining" && phase !== "syncing")) throw Error("Stale session acknowledgement");
    const valid = value && value.roomId === roomId && value.username === username &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.sessionId) &&
      /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.token) &&
      Number.isInteger(value.generation) &&
      value.generation === ticket.expectedGeneration + (ticket.kind === "transfer" ? 2 : 1) &&
      value.generation <= 2_147_483_647 &&
      Number.isFinite(value.expiresAt) && value.expiresAt > now() &&
      (!lease || (value.sessionId === lease.sessionId && value.token === lease.token &&
        value.expiresAt === lease.expiresAt));
    if (!valid) { block(); throw Error("Invalid session acknowledgement"); }
    let requestId: string;
    try { requestId = freshKey(); }
    catch (error) { block(); attempt = null; throw error; }
    lease = Object.freeze({ roomId, username, sessionId: value.sessionId, token: value.token,
      generation: value.generation, expiresAt: value.expiresAt });
    attempt = null;
    lostCas = null;
    phase = "syncing";
    syncAttempt = Object.freeze({ sessionId: lease.sessionId, generation: lease.generation, requestId });
    if (syncProtocol === "publication-cut") publication = createBrowserPublicationSnapshot({ roomId, ...syncAttempt }, now);
    else snapshot = createBrowserSnapshotWindow({ roomId, ...syncAttempt }, now);
    return syncAttempt;
  };
  return {
    /** Import only into a fresh controller. Storage is not authenticated READY. */
    restore(saved: LeaseCheckpoint) {
      if (phase !== "empty" || roomId || transport || lease) throw Error("Controller already owned");
      const row = structuredClone(saved);
      validateLeaseCheckpoint(row);
      roomId = row.roomId; username = row.username;
      lease = row.lease && Object.freeze(row.lease);
      const a = row.attempt;
      if (a) {
        usedKeys.add(a.operationId);
        if (a.originalOperationId) usedKeys.add(a.originalOperationId);
      }
      // A previous document has no reusable physical incarnation. A pending
      // original resume permits ONE explicit transfer; join/transfer loss does not.
      lostCas = a?.kind === "resume" ? { ticket: Object.freeze({ kind: "resume",
        operationId: a.operationId, expectedGeneration: a.expectedGeneration }), physical: {} } : null;
      phase = lease && lease.expiresAt <= now() ? "blocked" : a ? "uncertain" : "offline";
    },
    beginJoin(nextRoom: string, nextUser: string, physical: object): CasAttempt {
      if (!isValidRoomId(nextRoom) || !nextUser.trim() || nextUser.length > 64) throw Error("Invalid room owner");
      // Explicit join is the ONLY way to discard an old logical owner. The UI
      // must keep its unresolved drafts separately; they are not transferable.
      roomId = nextRoom; username = nextUser; transport = physical;
      stopPolling();
      snapshot?.cancel(); snapshot = null;
      publication?.cancel(); publication = null;
      lease = null; pending.clear(); usedKeys.clear(); phase = "joining";
      journal?.cancel(); journal = null;
      syncAttempt = null; lostCas = null;
      attempt = Object.freeze({ kind: "join", operationId: freshKey(), expectedGeneration: 0 });
      return attempt;
    },
    accept,
    disconnect(physical: object) {
      if (physical !== transport) return;
      stopPolling();
      transport = null;
      journal?.cancel(); journal = null;
      snapshot?.cancel(); snapshot = null;
      publication?.cancel(); publication = null;
      syncAttempt = null;
      if (phase === "blocked" || phase === "uncertain") return;
      // Keep ORIGINAL CAS provenance, never a transfer receipt/provenance chain.
      // Only an explicit atomic server transfer may resolve this uncertainty.
      lostCas = attempt?.kind === "resume" ? { ticket: attempt, physical } : null;
      phase = attempt ? "uncertain" : lease ? "offline" : "empty";
      attempt = null;
    },
    beginResume(physical: object): CasAttempt {
      const current = live();
      if (phase === "syncing" && attempt?.kind === "resume" && physical === transport) return attempt;
      if (phase !== "offline" || current.generation >= 2_147_483_647) throw Error("Resume requires reconciliation");
      transport = physical;
      attempt = Object.freeze({ kind: "resume", operationId: freshKey(), expectedGeneration: current.generation });
      phase = "syncing";
      return attempt;
    },
    beginTransfer(physical: object): TransferAttempt {
      const current = live();
      if (phase === "syncing" && attempt?.kind === "transfer" && physical === transport) return attempt;
      if (phase !== "uncertain" || !lostCas || physical === lostCas.physical ||
          current.generation !== lostCas.ticket.expectedGeneration ||
          current.generation > 2_147_483_645) throw Error("Transfer requires original CAS provenance");
      const transferOperationId = freshKey();
      attempt = Object.freeze({ kind: "transfer", originalOperationId: lostCas.ticket.operationId,
        expectedGeneration: lostCas.ticket.expectedGeneration, transferOperationId });
      // Consume locally BEFORE transport effects. A lost transfer ACK is terminal
      // for this logical owner; no replay or promotion into another original CAS.
      lostCas = null;
      transport = physical;
      phase = "syncing";
      return attempt;
    },
    reject(ticket: Attempt, physical: object) {
      if (ticket !== attempt || physical !== transport) return;
      block(); attempt = null;
    },
    publicationSnapshot(physical: object, ticket: SyncAttempt) {
      live();
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" || !publication) {
        throw Error("Stale publication acknowledgement");
      }
      return publication.api;
    },
    stagePublication(physical: object, ticket: SyncAttempt, completion: PublicationCompletion) {
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" || attempt) {
        throw Error("Stale publication acknowledgement");
      }
      live();
      try {
        if (!publication) throw Error("Missing publication snapshot");
        const staged = publication.consume(completion);
        // Remain syncing. No public READY path until durable ACK confirmation,
        // empty-cut semantics and continued journal reconciliation are composed.
        return staged;
      } catch (error) { block(); throw error; }
    },
    publicationAck(physical: object, ticket: SyncAttempt) {
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" || attempt) {
        throw Error("Stale publication acknowledgement");
      }
      live();
      try {
        if (!publication) throw Error("Missing publication snapshot");
        // The same immutable request/ID set may be retried after confirmation loss.
        // This does not extend its original deadline or claim delivery.
        return publication.retryAck();
      } catch (error) { block(); throw error; }
    },
    confirmPublication(physical: object, ticket: SyncAttempt, value: unknown) {
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" || attempt) {
        throw Error("Stale publication confirmation");
      }
      live();
      try {
        if (!publication) throw Error("Missing publication snapshot");
        const result = publication.confirm(value);
        journal = createBrowserPublicationJournal({ roomId, ...ticket }, result.history);
        publication = null;
        // A settled cut is NOT a continuing journal subscription. Never grant
        // READY here or discard pending payload/operation ownership.
        return result;
      } catch (error) { block(); throw error; }
    },
    snapshot(physical: object, ticket: SyncAttempt) {
      live();
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" || !snapshot) {
        throw Error("Stale history acknowledgement");
      }
      return snapshot.api;
    },
    receivePublication(physical: object, ticket: SyncAttempt, value: unknown) {
      if (physical !== transport || ticket !== syncAttempt ||
          (phase !== "syncing" && phase !== "ready") || attempt) {
        throw Error("Stale journal batch");
      }
      live();
      try {
        if (pump && !pump.live()) throw Error("Publication lifetime expired");
        if (!journal) throw Error("Missing confirmed publication journal");
        return journal.receive(value);
      } catch (error) { block(); throw error; }
    },
    startPublication(physical: object, ticket: SyncAttempt,
      poll: (signal: AbortSignal) => Promise<boolean>, clock?: PublicationClock) {
      const current = live();
      if (physical !== transport || ticket !== syncAttempt || phase !== "syncing" ||
          attempt || !journal || pump) throw Error("Publication lifetime requires confirmed cut");
      const owned = () => physical === transport && ticket === syncAttempt &&
        (phase === "syncing" || phase === "ready");
      pump = createBrowserPublicationPump({ expiresAt: current.expiresAt, clock, poll,
        synchronized: () => {
          if (!owned()) return;
          live();
          // READY means a confirmed cut plus a live reconciliation owner, NOT
          // an empty/drained journal, exactly-once delivery or reload durability.
          phase = "ready";
        },
        failed: () => { if (owned()) { block(); journal?.cancel(); } },
      });
    },
    finishSync(physical: object, generation: number, ticket: SyncAttempt, completion: SnapshotCompletion) {
      const current = live();
      if (ticket !== syncAttempt || physical !== transport || attempt ||
          phase !== "syncing" || generation !== current.generation) {
        throw Error("Stale history acknowledgement");
      }
      let result: SnapshotCompletion;
      try {
        if (!snapshot) throw Error("Missing snapshot");
        result = snapshot.consume(completion);
      } catch (error) { block(); throw error; }
      snapshot = null; syncAttempt = null;
      phase = "ready";
      return result;
    },
    beginOperation(kind: Operation["kind"], payloadHash: string): Operation {
      ready();
      if (!["message", "image", "file"].includes(kind) || !/^[a-f0-9]{64}$/.test(payloadHash)) throw Error("Invalid operation");
      if (pending.size >= maxPending) throw Error("Unresolved operation capacity reached");
      const operation = Object.freeze({ kind, payloadHash, clientMessageId: freshKey() });
      pending.set(operation, { sent: false });
      return operation;
    },
    dispatch(operation: Operation, physical: object) {
      const current = ready();
      const record = owns(operation);
      if (physical !== transport) throw Error("Transport changed");
      record.sent = true; // Mark BEFORE any network await, including a failed send.
      return Object.freeze({ ...current, ...operation });
    },
    reconcile(operation: Operation, physical: object, receipt: {
      sessionId: string; clientMessageId: string; kind: Operation["kind"];
      payloadHash: string; messageId: number;
    }) {
      const current = ready();
      const record = owns(operation);
      if (!record.sent || physical !== transport || receipt.sessionId !== current.sessionId ||
          receipt.clientMessageId !== operation.clientMessageId || receipt.kind !== operation.kind ||
          receipt.payloadHash !== operation.payloadHash || !Number.isSafeInteger(receipt.messageId) ||
          receipt.messageId < 1) throw Error("Receipt mismatch");
      pending.delete(operation);
      return receipt.messageId;
    },
    uploadAuthority(physical: object, socketId: string): UploadAuthority {
      const current = ready();
      if (physical !== transport || !socketId) throw Error("Transport changed");
      return Object.freeze({ kind: "resume", roomId, socketId,
        sessionId: current.sessionId, token: current.token });
    },
    status: () => ({ phase, pending: pending.size }),
  };
}
