import { ResumeBindings, type ResumeBinding } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";

export type ResumeUploadGrant = Readonly<{ binding: ResumeBinding }>;
type Lease = {
  currentGeneration: () => boolean; deadline: number; bytes: number;
  denied: boolean; release: () => void;
};
const processCapacity = new ResumeCapacity(100);
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DEADLINE_MS = 120_000;

// PRIVATE accounting only: one registry per server. No HTTP/FS/DB integration.
// Caller must authenticate the HTTP request and supply its server-owned binding,
// never a binding assembled from headers. A grant is an exact, opaque object.
// Deadline/denial fences future work; neither cancels I/O nor proves rollback.
export class ResumeUploadAdmissions {
  private readonly leases = new Map<ResumeUploadGrant, Lease>();
  private readonly sessions = new Set<string>();

  constructor(private readonly bindings: ResumeBindings,
    private readonly capacity = processCapacity,
    private readonly maxBytes = MAX_BYTES,
    private readonly timeoutMs = MAX_DEADLINE_MS,
    private readonly now = () => performance.now()) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_DEADLINE_MS) {
      throw Error("Invalid upload limits");
    }
  }

  admit(binding: ResumeBinding): ResumeUploadGrant | null {
    if (this.sessions.has(binding.sessionId)) return null;
    const currentGeneration = this.bindings.captureUploadGeneration(binding);
    if (!currentGeneration) return null;
    const release = this.capacity.acquire();
    if (!release) return null;
    const grant = Object.freeze({ binding });
    this.leases.set(grant, { currentGeneration, deadline: this.now() + this.timeoutMs,
      bytes: 0, denied: false, release });
    this.sessions.add(binding.sessionId);
    return grant;
  }

  isCurrent(grant: ResumeUploadGrant): boolean {
    const lease = this.leases.get(grant);
    if (!lease) return false;
    if (this.now() >= lease.deadline || !lease.currentGeneration()) lease.denied = true;
    return !lease.denied;
  }

  // Account each raw chunk BEFORE forwarding to a file writer. Never trust
  // Content-Length. This does not bound upstream buffering/multipart metadata.
  acceptChunk(grant: ResumeUploadGrant, byteLength: number): boolean {
    if (!this.isCurrent(grant)) return false;
    const lease = this.leases.get(grant)!;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 ||
        byteLength > this.maxBytes - lease.bytes) {
      lease.denied = true;
      return false;
    }
    lease.bytes += byteLength;
    return true;
  }

  // Server-only finalizer AFTER stream/file/DB work actually settles, never on
  // a timeout race or socket disconnect. Retaining a stalled slot fails closed.
  // Release is NOT permission to unlink or retry an uncertain/prior COMMIT.
  release(grant: ResumeUploadGrant): boolean {
    const lease = this.leases.get(grant);
    if (!lease) return false;
    this.leases.delete(grant);
    this.sessions.delete(grant.binding.sessionId);
    lease.release();
    return true;
  }
}
