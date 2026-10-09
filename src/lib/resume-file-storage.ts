import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { canonicalResumeFile, type ResumeStoredFile } from "./resume-file";
import { ResumeUploadAdmissions, type ResumeUploadGrant } from "./resume-upload-admission";

export type ResumeStagedFile = Readonly<{ file: ResumeStoredFile }>;

// Internal byte sink, exported for short-write/fencing fault injection tests.
export async function writeResumeChunk(
  write: (bytes: Buffer, offset: number, length: number) => Promise<number>,
  bytes: Buffer, current: () => boolean,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    if (!current()) throw Error("Upload denied");
    const written = await write(bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw Error("Invalid file write progress");
    }
    offset += written;
  }
}

// PRIVATE, not an HTTP parser. Root and ALL ancestors must be exclusively
// server-controlled, stable directories; hostile same-uid filesystem mutation
// is outside this contract. One instance per server/admission registry.
// Never deletes anything or releases admission, including on failure.
export class ResumeFileStorage {
  private readonly attempted = new WeakSet<ResumeUploadGrant>();
  private readonly receipts = new WeakMap<ResumeStagedFile, ResumeUploadGrant>();

  constructor(private readonly root: string, private readonly admissions: ResumeUploadAdmissions) {
    if (!isAbsolute(root)) throw Error("Upload root must be absolute");
  }

  resolve(grant: ResumeUploadGrant, result: ResumeStagedFile): ResumeStoredFile | null {
    return this.receipts.get(result) === grant && this.admissions.isCurrent(grant) ? result.file : null;
  }

  async stage(grant: ResumeUploadGrant, metadata: Readonly<{ name: string; mime: string }>,
    source: AsyncIterable<Uint8Array>): Promise<ResumeStagedFile> {
    if (!this.admissions.isCurrent(grant) || this.attempted.has(grant)) throw Error("Upload denied");
    // Validate/copy bounded metadata before filesystem effects or consuming bytes.
    const initial = canonicalResumeFile({ ...metadata, storageKey: randomBytes(32).toString("hex"),
      size: 0, sha256: "0".repeat(64) });
    this.attempted.add(grant);
    const current = () => this.admissions.isCurrent(grant);
    const check = () => { if (!current()) throw Error("Upload denied"); };
    let root: FileHandle | undefined, directory: FileHandle | undefined, file: FileHandle | undefined;
    try {
      root = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      check();
      const path = join(this.root, initial.storageKey);
      // Exclusive directory creation; collision fails without touching its contents.
      await mkdir(path, { mode: 0o700 });
      check();
      directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      check();
      file = await open(join(path, "blob"), constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      check();
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array) || !this.admissions.acceptChunk(grant, chunk.byteLength)) {
          throw Error("Upload denied");
        }
        // Snapshot caller-owned memory before awaiting any write. Admission
        // happens before the copy; an oversized chunk is never duplicated.
        const bytes = Buffer.from(chunk);
        await writeResumeChunk(async (b, offset, length) =>
          (await file!.write(b, offset, length, null)).bytesWritten, bytes, current);
        hash.update(bytes); size += bytes.length;
      }
      check();
      // Failure of ANY durability/close step prevents issuing a capability.
      await file.sync(); await file.close(); file = undefined;
      await directory.sync(); await directory.close(); directory = undefined;
      await root.sync(); await root.close(); root = undefined;
      check();
      const result = Object.freeze({ file: canonicalResumeFile({ ...initial, size, sha256: hash.digest("hex") }) });
      this.receipts.set(result, grant);
      return result;
    } finally {
      // Await ALL closes, even when one fails. No cleanup/unlink: an uncertain
      // later DB outcome or process crash requires durable reconciliation.
      const closed = await Promise.allSettled([file, directory, root].filter(
        (handle): handle is FileHandle => !!handle).map(handle => handle.close()));
      const failure = closed.find(r => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
}
