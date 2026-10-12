import type { Socket } from "socket.io";
import type { SnapshotRequest } from "./browser-resume-snapshot";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeHistoryReader } from "./resume-history";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeSocketOwner } from "./resume-socket";
import { syncResumeSocket } from "./resume-sync";
import { validateBrowserSnapshotRow } from "./browser-resume-snapshot";
import type { ResumePublication } from "./resume-publication";
import type { PublicationSnapshot } from "./resume-publication";
import { reconcilePublication } from "./resume-publication";

// Private continuing poll. Request identity binds the browser's retained cut;
// the existing poll owns physical membership, DB gate, one-flight and ACK lease.
// true is SQL settlement (or an empty poll), NEVER a drained/READY guarantee.
export async function reconcileBrowserPublication(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, store: ResumePublication,
  request: SnapshotRequest): Promise<boolean> {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId) ||
      members.currentBindingFor(socket, owner) !== binding) return false;
  const identity = Object.freeze({ ...request });
  return reconcilePublication(socket, owner, members, store, batch => {
    if (batch.roomId !== identity.roomId || batch.sessionId !== identity.sessionId ||
        batch.generation !== identity.generation || batch.messages.length > 16) {
      throw Error("Invalid browser journal batch");
    }
    const history = batch.messages.map(message => {
      const content = message.type === "message" ? { message: message.content } : JSON.parse(message.content);
      if (!content || typeof content !== "object" || Array.isArray(content) ||
          !(message.ts instanceof Date)) throw Error("Invalid journal content");
      return validateBrowserSnapshotRow({ ...content, id: message.id, type: message.type,
        username: message.username, ts: message.ts.getTime() });
    });
    if (Buffer.byteLength(JSON.stringify(history)) > 1024 * 1024) throw Error("Journal byte capacity");
    return Object.freeze({ ...identity, cut: "journal-batch", deliveryTry: batch.deliveryTry,
      history: Object.freeze(history) });
  });
}

// One retained request per physical socket. Supersession is permanent, including
// while SQL is pending. No public event registration or browser READY authority.
const exchanges = new WeakMap<Socket, object>();
export function createBrowserPublicationExchange(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships,
  store: Pick<ResumePublication, "snapshot" | "acknowledgeSnapshot">,
  request: SnapshotRequest, now = () => performance.now()) {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId) ||
      members.currentBindingFor(socket, owner) !== binding) return null;
  const identity = Object.freeze({ roomId: binding.roomId, sessionId: binding.sessionId,
    generation: binding.generation, requestId: request.requestId });
  const token = {}, deadline = now() + 4000;
  exchanges.set(socket, token);
  let started = false, batch: PublicationSnapshot | undefined;
  const live = () => exchanges.get(socket) === token && now() < deadline &&
    members.currentBindingFor(socket, owner) === binding;
  return Object.freeze({ request: identity,
    async publish(handoff: (value: unknown) => void): Promise<boolean> {
      if (started || !live()) return false;
      started = true;
      return publishBrowserPublicationSnapshot(socket, owner, binding, members, {
        snapshot: async current => {
          const cut = await store.snapshot(current);
          if (!cut || !live()) return null;
          // Own the DB cut across later awaits; caller mutation cannot change the
          // exact retained ACK set. Projection below still validates every row.
          batch = { ...cut, messages: cut.messages.map(row => ({ ...row, ts: new Date(row.ts) })) };
          return batch;
        },
      }, identity, value => {
        if (!live()) throw Error("Publication request superseded");
        handoff(value);
      }).then(sent => { if (!sent) batch = undefined; return sent; }, error => {
        batch = undefined; throw error;
      });
    },
    async acknowledge(reply: unknown, confirm: (value: unknown) => void): Promise<boolean> {
      if (!live() || !batch || !reply || typeof reply !== "object" || Array.isArray(reply)) return false;
      const ack = reply as Record<string, unknown>, retained = batch;
      if (ack.roomId !== identity.roomId || ack.sessionId !== identity.sessionId ||
          ack.generation !== identity.generation || ack.requestId !== identity.requestId ||
          ack.deliveryTry !== retained.deliveryTry || !Array.isArray(ack.ids) ||
          ack.ids.length !== retained.messages.length ||
          !ack.ids.every((id, i) => id === retained.messages[i].id)) return false;
      const captured = Object.freeze({ deliveryTry: retained.deliveryTry, ids: Object.freeze([...ack.ids]) });
      // Reuse physical close/expiry, shared per-socket flight and global capacity
      // fences. A timed-out SQL operation retains its slot until actual settlement.
      // Retrying lost confirmation rechecks durable SQL; never cache a boolean.
      return syncResumeSocket(socket, owner, binding, members, { read: async () => {
        if (!live()) return null;
        const committed = await store.acknowledgeSnapshot(binding, retained, captured);
        return committed && live() ? [] : null;
      } }, { roomId: identity.roomId }, () => {
        if (!live()) throw Error("Publication confirmation expired");
        confirm(Object.freeze({ ...identity, deliveryTry: retained.deliveryTry,
          cut: "full-bounded-statement", settled: true }));
      }, { timeoutMs: Math.max(1, Math.ceil(deadline - now())) });
    },
  });
}

// PRIVATE envelope over the existing exact-owner authorized full-window read.
// Caller binds this request/ACK to its authenticated physical socket. No probe,
// afterId, public registration or claim that IDs order commits. true = handoff.
export async function publishBrowserSnapshot(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, reader: Pick<ResumeHistoryReader, "read">,
  request: SnapshotRequest, handoff: (value: unknown) => void): Promise<boolean> {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) return false;
  const identity = Object.freeze({ roomId: binding.roomId, sessionId: binding.sessionId,
    generation: binding.generation, requestId: request.requestId });
  return syncResumeSocket(socket, owner, binding, members, reader, { roomId: binding.roomId }, reply => {
    if (!("history" in reply)) throw Error("Snapshot requires full history");
    handoff({ ...identity, window: "newest-100-id-ascending", history: reply.history, users: reply.users });
  });
}

// PRIVATE full-cut transport boundary. Uses the SAME physical-owner, membership,
// expiry and in-flight capacity fences as history sync, but never the newest100
// reader. true means synchronous handoff ONLY, not client ACK or browser READY.
// Empty cuts can be handed off; durable cut settlement is NOT wired here yet.
// Caller must retain this physical request and reconcile the durable journal.
export async function publishBrowserPublicationSnapshot(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, store: Pick<ResumePublication, "snapshot">,
  request: SnapshotRequest, handoff: (value: unknown) => void): Promise<boolean> {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) return false;
  const identity = Object.freeze({ roomId: binding.roomId, sessionId: binding.sessionId,
    generation: binding.generation, requestId: request.requestId });
  let deliveryTry: string | undefined;
  return syncResumeSocket(socket, owner, binding, members, { read: async current => {
    const cut = await store.snapshot(current);
    if (cut === null) return null;
    if (cut.cut !== "full-bounded-statement" || cut.roomId !== identity.roomId ||
        cut.sessionId !== identity.sessionId || cut.generation !== identity.generation ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cut.deliveryTry) ||
        !Array.isArray(cut.messages) || cut.messages.length > 256) throw Error("Invalid publication cut");
    let previous = 0, bytes = 2;
    const history = cut.messages.map((message, index) => {
      if (!(message.ts instanceof Date) || !Number.isFinite(message.ts.getTime())) {
        throw Error("Invalid publication timestamp");
      }
      // Persisted identity wins over JSON content. The shared browser validator
      // strips unknown fields and refuses corrupt/unsupported persisted media.
      const content = message.type === "message" ? { message: message.content } : JSON.parse(message.content);
      if (!content || typeof content !== "object" || Array.isArray(content)) throw Error("Invalid publication content");
      const row = validateBrowserSnapshotRow({ ...content, id: message.id, type: message.type,
        username: message.username, ts: message.ts.getTime() });
      if (row.id <= previous) throw Error("Publication cut must be ascending unique IDs");
      previous = row.id; bytes += Buffer.byteLength(JSON.stringify(row)) + (index ? 1 : 0);
      if (bytes > 1024 * 1024) throw Error("Publication projection byte capacity");
      return row;
    });
    deliveryTry = cut.deliveryTry;
    return Object.freeze(history);
  } }, { roomId: identity.roomId }, reply => {
    if (!("history" in reply) || !deliveryTry) throw Error("Missing publication cut");
    handoff(Object.freeze({ ...identity, cut: "full-bounded-statement", deliveryTry,
      history: reply.history, users: Object.freeze([...reply.users]) }));
  });
}
