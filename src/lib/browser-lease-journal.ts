import type { BrowserLease } from "./browser-resume-controller";
import { isValidRoomId, normalizeRoomId } from "./room-id";

type Attempt = Readonly<{ kind: "join" | "resume" | "transfer"; operationId: string;
  expectedGeneration: number; originalOperationId?: string }>;
export type LeaseCheckpoint = Readonly<{ version: 1; revision: string; roomId: string;
  username: string; lease: BrowserLease | null; attempt: Attempt | null }>;
export type LeaseChange =
  | { kind: "join"; roomId: string; username: string; operationId: string }
  | { kind: "resume" | "transfer"; operationId: string }
  | { kind: "accept"; lease: BrowserLease };
export type LeaseMutation = { expectedRevision: string | null; change: LeaseChange |
  { kind: "join-not-issued"; operationId: string } };
export function assertUnissuedJoin(current: LeaseCheckpoint | undefined, expectedRevision: string | null,
  operationId: string) {
  if (current) validateLeaseCheckpoint(current);
  if (!current || current.revision !== expectedRevision || current.lease !== null ||
      current.attempt?.kind !== "join" || current.attempt.operationId !== operationId)
    throw Error("Cannot clear an uncertain or different session");
}
const key = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const generation = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= 2_147_483_647;
function validLease(value: BrowserLease, room: string, user: string) {
  return value && value.roomId === room && value.username === user &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.sessionId) &&
    typeof value.token === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.token) &&
    generation(value.generation) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}
export function validateLeaseCheckpoint(row: LeaseCheckpoint) {
  if (!row || row.version !== 1 || !key(row.revision) ||
      typeof row.roomId !== "string" || !isValidRoomId(row.roomId) ||
      normalizeRoomId(row.roomId) !== row.roomId ||
      typeof row.username !== "string" || !row.username.trim() || row.username.length > 64 ||
      (row.lease !== null && !validLease(row.lease, row.roomId, row.username))) {
    throw Error("Invalid saved session");
  }
  const a = row.attempt;
  if (a === null) { if (!row.lease) throw Error("Missing saved lease"); return; }
  if (!a || !key(a.operationId) ||
      (a.kind === "join" ? row.lease !== null || a.expectedGeneration !== 0 || a.originalOperationId !== undefined :
       a.kind === "resume" || a.kind === "transfer" ?
         !row.lease || a.expectedGeneration !== row.lease.generation ||
         (a.kind === "transfer" ? !key(a.originalOperationId) || a.originalOperationId === a.operationId :
          a.originalOperationId !== undefined) : true)) throw Error("Invalid saved CAS provenance");
}

/** Pure journal transition. A record is NOT authentication, synchronization or READY. */
export function advanceLeaseCheckpoint(current: LeaseCheckpoint | undefined, expectedRevision: string | null,
  change: LeaseChange, revision: string, now = Date.now()): LeaseCheckpoint {
  if (!key(revision) || revision === expectedRevision || !Number.isSafeInteger(now)) throw Error("Invalid revision");
  if (current) validateLeaseCheckpoint(current);
  if ((current?.revision ?? null) !== expectedRevision) throw Error("Session journal ownership changed");
  if (change.kind === "join") {
    if (current || !isValidRoomId(change.roomId) || normalizeRoomId(change.roomId) !== change.roomId ||
        !change.username.trim() || change.username.length > 64 || !key(change.operationId)) {
      throw Error("New session requires an empty owner journal");
    }
    return { version: 1, revision, roomId: change.roomId, username: change.username, lease: null,
      attempt: { kind: "join", operationId: change.operationId, expectedGeneration: 0 } };
  }
  if (!current) throw Error("Missing original session");
  if (current.lease && current.lease.expiresAt <= now) throw Error("Session expired; retain unresolved work");
  if (change.kind === "accept") {
    const a = current.attempt, value = change.lease, old = current.lease;
    if (!a || !validLease(value, current.roomId, current.username) || value.expiresAt <= now ||
        value.generation !== a.expectedGeneration + (a.kind === "transfer" ? 2 : 1) ||
        (old && (value.sessionId !== old.sessionId || value.token !== old.token ||
          value.expiresAt !== old.expiresAt))) throw Error("Invalid session acknowledgement");
    return { ...current, revision, lease: { roomId: value.roomId, username: value.username,
      sessionId: value.sessionId, token: value.token, generation: value.generation,
      expiresAt: value.expiresAt }, attempt: null };
  }
  if (!current.lease || !key(change.operationId)) throw Error("Missing original session");
  if (change.kind === "resume") {
    if (current.attempt || current.lease.generation >= 2_147_483_647) throw Error("Resume requires settled provenance");
    return { ...current, revision, attempt: { kind: "resume", operationId: change.operationId,
      expectedGeneration: current.lease.generation } };
  }
  const original = current.attempt;
  if (change.kind !== "transfer" || original?.kind !== "resume" ||
      change.operationId === original.operationId || current.lease.generation > 2_147_483_645) {
    throw Error("Transfer requires original CAS provenance");
  }
  return { ...current, revision, attempt: { kind: "transfer", operationId: change.operationId,
    originalOperationId: original.operationId, expectedGeneration: original.expectedGeneration } };
}

/**
 * PRIVATE migration primitive. Commit BEFORE any transport effect; resolve ONLY
 * on strict transaction completion. An interrupted resume remains uncertain and
 * may only enter one explicit server transfer, never another automatic resume.
 * Only exact server-confirmed non-issuance can clear a lease-less join intent.
 * No issued-lease deletion, expiry extension, token invention, payload settlement or replay.
 * Same-origin storage is not an authentication or cloned-tab security boundary.
 */
export async function browserLeaseJournal(scope: string,
  mutation?: LeaseMutation,
  factory: IDBFactory = indexedDB, now = Date.now): Promise<LeaseCheckpoint | undefined> {
  if (!scope || scope.length > 1024) throw Error("Invalid local owner scope");
  // Snapshot caller input before the first await; later edits cannot change admission.
  const input = mutation && structuredClone(mutation);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("dimle-browser-lease-v1", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("leases");
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error("Session storage blocked")); };
  });
  try {
    return await new Promise<LeaseCheckpoint | undefined>((resolve, reject) => {
      const tx = db.transaction("leases", input ? "readwrite" : "readonly", { durability: "strict" });
      const store = tx.objectStore("leases");
      let result: LeaseCheckpoint | undefined, failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
          result = request.result;
          if (result) validateLeaseCheckpoint(result);
          if (!input) return;
          if (input.change.kind === "join-not-issued") {
            assertUnissuedJoin(result, input.expectedRevision, input.change.operationId);
            store.delete(scope); result = undefined; return;
          }
          const next = advanceLeaseCheckpoint(result, input.expectedRevision, input.change, crypto.randomUUID(), now());
          const put = () => { result = next; store.put(next, scope); };
          if (result) put();
          else {
            const count = store.count();
            count.onsuccess = () => {
              try { if (count.result >= 8) throw Error("Session journal capacity reached"); put(); }
              catch (error) { fail(error); }
            };
          }
        } catch (error) { fail(error); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? Error("Session storage unavailable"));
      tx.onerror = () => {};
    });
  } finally { db.close(); }
}
