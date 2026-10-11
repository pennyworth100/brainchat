import type { StrictFileStorage } from "./strict-file-storage";
import type { ResumeFileWriter, ResumeFileWrite } from "./resume-file";
import type { ResumeUploadGrant } from "./resume-upload-admission";
import type { OperationOutcome } from "./resume-operation";

// PRIVATE only. No HTTP registration, publication, release, refund or deletion.
export class StrictMultipartUpload {
  private readonly attempts = new WeakMap<ResumeUploadGrant, Promise<OperationOutcome<ResumeFileWrite>>>();
  constructor(private readonly storage: StrictFileStorage, private readonly writer: ResumeFileWriter) {}

  async saveWithOutcome(grant: ResumeUploadGrant, clientMessageId: string,
    source: Parameters<StrictFileStorage["stageMultipart"]>[2],
    framing: Parameters<StrictFileStorage["stageMultipart"]>[3],
    timeoutMs?: number): Promise<OperationOutcome<ResumeFileWrite>> {
    const prior = this.attempts.get(grant);
    if (prior) {
      await prior;
      return { completed: true, result: { authorized: false } };
    }
    const attempt = Promise.resolve().then(async (): Promise<OperationOutcome<ResumeFileWrite>> => {
      let file;
      try {
        const staged = await this.storage.stageMultipart(grant, clientMessageId, source, framing, timeoutMs);
        file = this.storage.resolve(grant, staged);
        if (!file) return { completed: true, result: { authorized: false } };
      } catch (error) {
        return { completed: false, commit: "not-dispatched", error };
      }
      try {
        return await this.writer.saveOnceWithOutcome(grant, clientMessageId, file);
      } catch (error) {
        return { completed: false, commit: "unknown", error };
      }
    });
    this.attempts.set(grant, attempt); // installed before authority/parser/IO
    return attempt;
  }
}
