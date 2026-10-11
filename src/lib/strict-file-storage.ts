import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalResumeFile, type ResumeStoredFile } from "./resume-file";
import { writeResumeChunk, type ResumeStagedFile } from "./resume-file-storage";
import { ResumeUploadAdmissions, type ResumeUploadGrant } from "./resume-upload-admission";
import { StrictUploadAccounting, type StrictUploadAccountingReceipt } from "./strict-upload-accounting";
import { openStrictUploadRoot, strictUploadRootPath } from "./upload-storage-root";

export type StrictStorageRequest = Readonly<NonNullable<ReturnType<StrictUploadAccounting["resolve"]>> &
  { storageKey: string }>;

/** TRUSTED provisioning interface, NOT a physical implementation. No production
 * provider exists. A provider must durably cover bytes AND objects for this exact
 * request before returning an opaque receipt. Missing/unknown authority denies.
 * Charges must NEVER be reclaimed by timeout, disconnect, expiry, failure or
 * successful return: file/DB/unknown outcomes require separate reconciliation.
 * isCurrent verifies exact receipt+request identity and remaining write authority.
 * Arithmetic quotes/accounting receipts/statfs are not valid implementations.
 */
export interface StrictStoragePhysicalAuthority {
  authorize(request: StrictStorageRequest): Promise<object | null>;
  isCurrent(receipt: object, request: StrictStorageRequest): boolean;
}
export type StrictStorageSession = Readonly<{ kind: "strict-storage-session" }>;
type SessionRecord = Readonly<{
  grant: ResumeUploadGrant; accounting: StrictUploadAccountingReceipt;
  request: StrictStorageRequest; physical: object;
}>;
const attempted = new WeakSet<ResumeUploadGrant>();

/** PRIVATE strict sink. No runtime registration, parser, release, deletion,
 * refund, retry or physical-provider implementation. Stable exclusive ancestors
 * and no hostile same-uid filesystem mutation remain required by the root API.
 */
export class StrictFileStorage {
  private readonly physical;
  private readonly sessions = new WeakMap<StrictStorageSession, SessionRecord>();
  private readonly consumed = new WeakSet<StrictStorageSession>();
  private readonly receipts = new WeakMap<ResumeStagedFile, Readonly<{
    grant: ResumeUploadGrant; accounting: StrictUploadAccountingReceipt;
    request: StrictStorageRequest; physical: object;
  }>>();

  constructor(private readonly admissions: ResumeUploadAdmissions,
    private readonly accounting: StrictUploadAccounting,
    physical: StrictStoragePhysicalAuthority | null) {
    this.physical = physical && Object.freeze({
      authorize: physical.authorize.bind(physical), isCurrent: physical.isCurrent.bind(physical),
    });
  }

  resolve(grant: ResumeUploadGrant, result: ResumeStagedFile): ResumeStoredFile | null {
    const r = this.receipts.get(result);
    return r?.grant === grant && this.accounting.resolve(grant, r.accounting) &&
      this.physical?.isCurrent(r.physical, r.request) ? result.file : null;
  }

  /** No metadata, body or filesystem access. Call BEFORE starting a parser.
   * The receipt binds the exact grant, client key, operation/attempt, root, pin
   * and limit. It is not a staged-file receipt and cannot authorize DB dispatch.
   */
  async authorize(grant: ResumeUploadGrant, clientMessageId: string): Promise<StrictStorageSession> {
    const physical = this.physical;
    if (!physical || !this.admissions.isCurrent(grant) || attempted.has(grant)) throw Error("Strict storage denied");
    const key = clientMessageId;
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw Error("Invalid strict upload identity");
    attempted.add(grant); // synchronous, shared across storage coordinators
    const reserved = await this.accounting.reserve(grant, key);
    if (reserved.status !== "settled" || !reserved.receipt) throw Error("Strict accounting denied or uncertain");
    const accountingReceipt = reserved.receipt;
    const record = this.accounting.resolve(grant, accountingReceipt);
    if (!record || record.clientMessageId !== key || record.limit !== this.admissions.byteLimit(grant)) {
      throw Error("Strict accounting identity denied");
    }
    // Deterministic reconciliation mapping, not an authority or client-selected path.
    const storageKey = createHash("sha256").update(JSON.stringify([
      "strict-upload-storage-v1", record.operationId, record.attemptId,
    ])).digest("hex");
    const request: StrictStorageRequest = Object.freeze({ ...record, storageKey });
    const permit = await physical.authorize(request);
    if (!permit || this.accounting.resolve(grant, accountingReceipt) !== record ||
        !physical.isCurrent(permit, request)) throw Error("Strict physical storage denied");
    const session = Object.freeze({ kind: "strict-storage-session" as const });
    this.sessions.set(session, Object.freeze({ grant, accounting: accountingReceipt, request, physical: permit }));
    return session;
  }

  /** Recheck before parser entry; staging performs its own IO rechecks. No copied/cross-owner
   * session, expired grant or consumed session is reusable authority.
   */
  isAuthorized(grant: ResumeUploadGrant, session: StrictStorageSession): boolean {
    const r = this.sessions.get(session);
    return !!r && r.grant === grant && !this.consumed.has(session) &&
      !!this.accounting.resolve(grant, r.accounting) &&
      !!this.physical?.isCurrent(r.physical, r.request);
  }

  async stage(grant: ResumeUploadGrant,
    metadata: Readonly<{ name: string; mime: string; clientMessageId: string }>,
    source: AsyncIterable<Uint8Array>): Promise<ResumeStagedFile> {
    if (!this.physical || !this.admissions.isCurrent(grant) || attempted.has(grant)) throw Error("Strict storage denied");
    // Keep legacy private callers' synchronous snapshot/validation semantics.
    const captured = canonicalResumeFile({ name: metadata.name, mime: metadata.mime,
      storageKey: "0".repeat(64), size: 0, sha256: "0".repeat(64) });
    const session = await this.authorize(grant, metadata.clientMessageId);
    return this.stageAuthorized(grant, session, captured, source);
  }

  async stageAuthorized(grant: ResumeUploadGrant, session: StrictStorageSession,
    metadata: Readonly<{ name: string; mime: string }>,
    source: AsyncIterable<Uint8Array>): Promise<ResumeStagedFile> {
    if (!this.isAuthorized(grant, session)) throw Error("Strict storage session denied");
    this.consumed.add(session); // synchronous single use, including invalid metadata
    const r = this.sessions.get(session)!;
    const { request: record, accounting: accountingReceipt, physical: permit } = r;
    const request = record, storageKey = record.storageKey;
    const initial = canonicalResumeFile({ name: metadata.name, mime: metadata.mime,
      storageKey: "0".repeat(64), size: 0, sha256: "0".repeat(64) });
    const current = () => !!this.accounting.resolve(grant, accountingReceipt) &&
      !!this.physical?.isCurrent(permit, request);
    const check = () => { if (!current()) throw Error("Strict physical storage denied"); };
    check(); // No body/filesystem access before both distinct authorities.
    const rootPath = strictUploadRootPath(record.root, record.pin, record.limit);
    if (!rootPath) throw Error("Strict root denied");
    let root: FileHandle | undefined, directory: FileHandle | undefined, file: FileHandle | undefined;
    try {
      root = await openStrictUploadRoot(record.root, record.pin, record.limit);
      check();
      const path = join(rootPath, storageKey);
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
        check();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > record.limit - size ||
            !this.admissions.acceptChunk(grant, chunk.byteLength)) throw Error("Strict upload denied");
        const bytes = Buffer.from(chunk);
        await writeResumeChunk(async (b, offset, length) =>
          (await file!.write(b, offset, length, null)).bytesWritten, bytes, current);
        // Do not pull another source chunk after authority changed during IO.
        check();
        hash.update(bytes); size += bytes.length;
      }
      check();
      await file.sync(); await file.close(); file = undefined;
      await directory.sync(); await directory.close(); directory = undefined;
      await root.sync(); await root.close(); root = undefined;
      check();
      const result = Object.freeze({ file: canonicalResumeFile({
        ...initial, storageKey, size, sha256: hash.digest("hex"),
      }) });
      this.receipts.set(result, Object.freeze({ grant, accounting: accountingReceipt, request, physical: permit! }));
      return result;
    } finally {
      const closed = await Promise.allSettled([file, directory, root].filter(
        (h): h is FileHandle => !!h).map(h => h.close()));
      const failure = closed.find(r => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
}
