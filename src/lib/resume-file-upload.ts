import { ResumeFileStorage } from "./resume-file-storage";
import { ResumeFileWriter, type ResumeFileWrite } from "./resume-file";
import type { OperationOutcome } from "./resume-operation";
import type { ResumeUploadGrant } from "./resume-upload-admission";

// PRIVATE composition; one instance per server. No HTTP, publication, release,
// unlink or automatic retry. A retry requires a fresh admission and byte attempt.
export class ResumeFileUpload {
  private readonly attempts = new WeakMap<ResumeUploadGrant, Promise<OperationOutcome<ResumeFileWrite>>>();

  constructor(private readonly storage: ResumeFileStorage, private readonly writer: ResumeFileWriter) {}

  async saveWithOutcome(grant: ResumeUploadGrant, clientMessageId: string,
    metadata: Readonly<{ name: string; mime: string }>,
    source: AsyncIterable<Uint8Array>): Promise<OperationOutcome<ResumeFileWrite>> {
    const prior = this.attempts.get(grant);
    if (prior) {
      // Wait for actual settlement, but never hand out a second inserted:true
      // result (which could cause a duplicate broadcast). Even another key is
      // denied. This cannot authorize a second dispatch or early lease release.
      await prior;
      return { completed: true, result: { authorized: false } };
    }
    // Capture identity/metadata synchronously, before any filesystem effects.
    if (typeof clientMessageId !== "string" || !clientMessageId.length ||
        clientMessageId.length > 128 || /[^A-Za-z0-9_-]/.test(clientMessageId)) {
      return { completed: false, commit: "not-dispatched", error: Error("Invalid resume file identity") };
    }
    const captured = { name: metadata.name, mime: metadata.mime, clientMessageId };
    // Install the single-attempt promise BEFORE starting asynchronous work.
    const attempt = Promise.resolve().then(async (): Promise<OperationOutcome<ResumeFileWrite>> => {
      let file;
      try {
        const staged = await this.storage.stage(grant, captured, source);
        file = this.storage.resolve(grant, staged);
        if (!file) return { completed: true, result: { authorized: false } };
      } catch (error) {
        return { completed: false, commit: "not-dispatched", error };
      }
      // Files/iterator are settled before DB work. Only the exact storage-issued
      // capability can supply metadata; callers cannot provide a path or digest.
      try {
        return await this.writer.saveOnceWithOutcome(grant, clientMessageId, file);
      } catch (error) {
        // Defensive: an unexpected writer exception cannot disprove COMMIT.
        return { completed: false, commit: "unknown", error };
      }
    });
    this.attempts.set(grant, attempt);
    return attempt;
  }
}
