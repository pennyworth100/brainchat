import { isValidRoomId } from "./room-id";
import type { UploadAuthority } from "./upload-authority";

export type BrowserLease = Readonly<{
  roomId: string; username: string; sessionId: string; token: string;
  generation: number; expiresAt: number;
}>;
type Phase = "empty" | "joining" | "syncing" | "ready" | "offline" | "uncertain" | "blocked";
type Attempt = Readonly<{ kind: "join" | "resume"; operationId: string; expectedGeneration: number }>;
type SyncAttempt = Readonly<{ sessionId: string; generation: number }>;
type Operation = Readonly<{ clientMessageId: string; kind: "message" | "image" | "file"; payloadHash: string }>;
const validKey = (key: string) => /^[A-Za-z0-9_-]{16,128}$/.test(key);

/**
 * Private migration core; NOT wired to the public browser/server yet.
 * Memory-only, no storage, transport effects, legacy fallback or automatic CAS.
 * A transport object must identify one physical connection incarnation.
 */
export function createBrowserResumeController(
  newKey = () => crypto.randomUUID(), now = Date.now, maxPending = 32,
) {
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw Error("Invalid pending limit");
  let phase: Phase = "empty";
  let roomId = "", username = "";
  let lease: BrowserLease | null = null;
  let transport: object | null = null;
  let attempt: Attempt | null = null;
  let syncAttempt: SyncAttempt | null = null;
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
      phase = "blocked";
      throw Error("Session expired");
    }
    return lease;
  };
  const ready = () => {
    const current = live();
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
      Number.isInteger(value.generation) && value.generation === ticket.expectedGeneration + 1 &&
      value.generation <= 2_147_483_647 &&
      Number.isFinite(value.expiresAt) && value.expiresAt > now() &&
      (!lease || (value.sessionId === lease.sessionId && value.token === lease.token &&
        value.expiresAt === lease.expiresAt));
    if (!valid) { phase = "blocked"; throw Error("Invalid session acknowledgement"); }
    lease = Object.freeze({ roomId, username, sessionId: value.sessionId, token: value.token,
      generation: value.generation, expiresAt: value.expiresAt });
    attempt = null;
    phase = "syncing";
    return syncAttempt = Object.freeze({ sessionId: lease.sessionId, generation: lease.generation });
  };
  return {
    beginJoin(nextRoom: string, nextUser: string, physical: object): Attempt {
      if (!isValidRoomId(nextRoom) || !nextUser.trim() || nextUser.length > 64) throw Error("Invalid room owner");
      // Explicit join is the ONLY way to discard an old logical owner. The UI
      // must keep its unresolved drafts separately; they are not transferable.
      roomId = nextRoom; username = nextUser; transport = physical;
      lease = null; pending.clear(); usedKeys.clear(); phase = "joining";
      syncAttempt = null;
      attempt = Object.freeze({ kind: "join", operationId: freshKey(), expectedGeneration: 0 });
      return attempt;
    },
    accept,
    disconnect(physical: object) {
      if (physical !== transport) return;
      transport = null;
      syncAttempt = null;
      if (phase === "blocked" || phase === "uncertain") return;
      // A lost CAS ACK cannot be resolved by guessing a generation or retrying
      // on another transport. A future authenticated lookup adapter is required.
      phase = attempt ? "uncertain" : lease ? "offline" : "empty";
      attempt = null;
    },
    beginResume(physical: object): Attempt {
      const current = live();
      if (phase === "syncing" && attempt?.kind === "resume" && physical === transport) return attempt;
      if (phase !== "offline" || current.generation >= 2_147_483_647) throw Error("Resume requires reconciliation");
      transport = physical;
      attempt = Object.freeze({ kind: "resume", operationId: freshKey(), expectedGeneration: current.generation });
      phase = "syncing";
      return attempt;
    },
    reject(ticket: Attempt, physical: object) {
      if (ticket !== attempt || physical !== transport) return;
      phase = "blocked"; attempt = null;
    },
    finishSync(physical: object, generation: number, ticket: SyncAttempt) {
      const current = live();
      if (ticket !== syncAttempt || physical !== transport || attempt ||
          phase !== "syncing" || generation !== current.generation) {
        throw Error("Stale history acknowledgement");
      }
      syncAttempt = null;
      phase = "ready";
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
