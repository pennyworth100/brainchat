import type { Socket } from "socket.io";
import type { ResumeSocketOwner } from "./resume-socket";
import type { ResumeMemberships } from "./resume-membership";
import { hashResumeToken, type ResumeStore } from "./resume-store";
import type { ResumeUploadAdmissions, ResumeUploadGrant } from "./resume-upload-admission";
import { ResumeCapacity } from "./resume-capacity";
import { resumeUploadRate } from "./resume-upload-rate";

const capacity = new ResumeCapacity(100);
const pending = new WeakSet<Socket>();
type Request = { roomId?: unknown; sessionId?: unknown; token?: unknown } | null;
type Limits = { capacity?: ResumeCapacity; timeoutMs?: number; now?: () => number };

// PRIVATE pre-body seam, NOT installed in server.ts. Socket and owner must come
// from the server's authoritative registry. Knowing socket.id is not sufficient:
// the bounded bearer credential must authenticate through the durable store.
// No parser/source/FS, CAS, publication, retry or upload lease release here.
export async function preflightResumeUpload(socket: Socket, owner: ResumeSocketOwner,
  members: ResumeMemberships, store: Pick<ResumeStore, "lookup">,
  uploads: ResumeUploadAdmissions, request: Request, limits: Limits = {}): Promise<ResumeUploadGrant | null> {
  // Charge every call globally, including malformed/unowned requests. Scope
  // session debt ONLY by current server-owned identity, before payload checks.
  if (!resumeUploadRate.consumeAggregate()) return null;
  const binding = members.currentBindingFor(socket, owner);
  if (!binding || !resumeUploadRate.consumeSession(binding.sessionId)) return null;
  const roomId = request?.roomId, sessionId = request?.sessionId, token = request?.token;
  if (typeof roomId !== "string" || typeof sessionId !== "string" ||
      typeof token !== "string" || !hashResumeToken(token)) return null;
  if (binding.roomId !== roomId || binding.sessionId !== sessionId || pending.has(socket)) return null;
  const timeoutMs = limits.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw Error("Invalid upload preflight deadline");
  }
  const now = limits.now ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) return null;
  const release = (limits.capacity ?? capacity).acquire();
  if (!release) return null;
  pending.add(socket);
  try {
    // Snapshot BEFORE await. Store.lookup validates canonical session/token and
    // durable room policy/revocation/expiry. Never trust request identity fields.
    const authenticated = await store.lookup(Object.freeze({ roomId, sessionId, token }));
    const finished = now();
    if (!Number.isFinite(finished) || finished < started || finished >= started + timeoutMs ||
        members.bindingFor(socket, owner, roomId) !== binding || !authenticated ||
        authenticated.sessionId !== binding.sessionId || authenticated.roomId !== binding.roomId ||
        authenticated.username !== binding.username || authenticated.authVersion !== binding.authVersion ||
        authenticated.generation !== binding.generation ||
        !(authenticated.expiresAt instanceof Date) || authenticated.expiresAt.getTime() !== binding.expiresAt) return null;
    // No await between exact-owner revalidation and opaque grant acquisition.
    // Durable upload gate still rechecks policy before/after DB work: lookup is
    // not a lock and cannot prevent later revocation or a remote successor.
    return uploads.admit(binding);
  } finally {
    // A deadline does not cancel lookup. Hung lookup retains BOTH leases; no
    // early timeout result, parser start or replacement wrapper bypass.
    pending.delete(socket); release();
  }
}
