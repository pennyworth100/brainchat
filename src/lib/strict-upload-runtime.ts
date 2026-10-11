import type { IncomingMessage } from "node:http";
import { StrictMultipartUpload } from "./strict-multipart-upload";
import type { StrictFileStorage } from "./strict-file-storage";
import type { ResumeFileWriter, ResumeFileWrite } from "./resume-file";
import { ResumeUploadAdmissions, type ResumeUploadGrant } from "./resume-upload-admission";
import { resumeHttpSource } from "./resume-http-source";
import { validateResumeUploadFraming } from "./resume-upload-framing";

export type StrictUploadRuntimeResult =
  | { status: "unavailable" | "invalid" | "denied" }
  | { status: "failed"; commit: "not-dispatched" | "unknown"; error: unknown }
  | { status: "saved"; value: ResumeFileWrite };

/** Server-owned HTTP lifetime, not provisioning authority. A null storage is
 * mandatory until physical byte+object authority AND exact download mapping
 * have been installed. No environment flag or client input can activate it.
 * No release on disconnect/deadline; no physical refund, unlink or retry.
 */
export class StrictUploadRuntime {
  private readonly upload: StrictMultipartUpload | null;
  private readonly attempts = new WeakMap<ResumeUploadGrant, Promise<StrictUploadRuntimeResult>>();
  private readonly pending = new Set<Promise<StrictUploadRuntimeResult>>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly admissions: ResumeUploadAdmissions,
    storage: StrictFileStorage | null, writer: ResumeFileWriter) {
    this.upload = storage ? new StrictMultipartUpload(storage, writer) : null;
  }

  run(grant: ResumeUploadGrant, request: IncomingMessage): Promise<StrictUploadRuntimeResult> {
    const prior = this.attempts.get(grant);
    // Wait without releasing the original lease or returning its inserted:true
    // receipt to a second publisher.
    if (prior) return prior.then(() => ({ status: "denied" as const }));
    const task = Promise.resolve().then(async (): Promise<StrictUploadRuntimeResult> => {
      try {
        // No header getter, source, parser, accounting or FS access when absent.
        if (this.closed || !this.upload) return { status: "unavailable" };
        if (!this.admissions.isCurrent(grant)) return { status: "denied" };
        const key = request.headers["x-client-message-id"];
        const framing = validateResumeUploadFraming(request);
        if (typeof key !== "string" || key.length < 1 || key.length > 128 || /[^A-Za-z0-9_-]/.test(key) || !framing) {
          return { status: "invalid" };
        }
        // Dormant source: physical/accounting authority is checked by storage
        // before starting iteration. Await includes actual parser/IO/SQL close.
        const outcome = await this.upload.saveWithOutcome(grant, key, resumeHttpSource(request), framing);
        if (!outcome.completed) return { status: "failed", commit: outcome.commit, error: outcome.error };
        if (!outcome.result.authorized) return { status: "denied" };
        return { status: "saved", value: outcome.result.value };
      } catch (error) {
        // Unexpected exceptions cannot establish rollback.
        return { status: "failed", commit: "unknown", error };
      } finally {
        this.admissions.release(grant);
      }
    });
    this.attempts.set(grant, task);
    this.pending.add(task);
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.pending]).then(() => {});
    return this.closing;
  }
}
