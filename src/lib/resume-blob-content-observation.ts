import fs, { type FileHandle } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

export type BlobContentObservation = {
  metadata: { sizeBytes: string; linkCount: string } | null;
  bytesRead: number;
  sha256: string | null;
  stability: "unchanged-at-checks" | "unstable" | "unobserved";
  complete: boolean;
  reasons: string[];
  crossStoreStability: "unproven";
};
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// PRIVATE: no runtime caller. Caller MUST ensure trusted, stable ENTIRE ancestry
// including root/key. Held handles are NOT openat / hostile same-uid protection.
// Sequential checks are NOT a snapshot, ownership, DB agreement or later authority.
// Reads can update filesystem atime. No writes, repair, refund, delete or replay.
// Deadline bounds admission, NOT pending kernel I/O or close latency.
export async function observeUploadBlobContent(root: string, storageKey: string,
  limits: { maxBytes: number; maxReads: number; maxMs: number; trustedStableAncestry: boolean },
  io: Pick<typeof fs, "open" | "lstat"> = fs,
  now: () => number = () => performance.now(),
): Promise<BlobContentObservation> {
  const report: BlobContentObservation = { metadata: null, bytesRead: 0, sha256: null,
    stability: "unobserved", complete: false, reasons: [], crossStoreStability: "unproven" };
  const { maxBytes, maxReads, maxMs, trustedStableAncestry } = limits;
  if (!isAbsolute(root) || trustedStableAncestry !== true ||
      typeof storageKey !== "string" || storageKey.length !== 64 || !/^[a-f0-9]{64}$/.test(storageKey) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 4096 ||
      !Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 30000) {
    report.reasons.push("invalid-contract"); return report;
  }
  const started = now(), deadline = started + maxMs;
  let last = started;
  const check = () => { const time = now();
    if (!Number.isFinite(started) || !Number.isFinite(time) || time < last || time >= deadline) throw Error("deadline");
    last = time;
  };
  const held: { path: string; handle: FileHandle; before: BigIntStats }[] = [];
  const handles: FileHandle[] = [];
  let digest: string | null = null;
  try {
    for (const path of [root, join(root, storageKey), join(root, storageKey, "blob")]) {
      const blob = held.length === 2;
      check(); const prior = await io.lstat(path, { bigint: true }); check();
      if (blob ? !prior.isFile() : !prior.isDirectory()) throw Error("unsupported-type");
      check(); const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
        (blob ? constants.O_NONBLOCK : constants.O_DIRECTORY));
      handles.push(handle);
      check(); const before = await handle.stat({ bigint: true }); check();
      if (!same(prior, before) || (blob ? !before.isFile() : !before.isDirectory())) throw Error("path-unstable");
      held.push({ path, handle, before });
      if (blob) {
        if (before.size < 0n || before.nlink !== 1n) throw Error("unsupported-metadata");
        report.metadata = { sizeBytes: before.size.toString(), linkCount: before.nlink.toString() };
        if (before.size > BigInt(maxBytes)) throw Error("byte-limit");
      }
    }
    const file = held[2], size = Number(file.before.size);
    const buffer = Buffer.alloc(Math.min(64 * 1024, size));
    const hash = createHash("sha256");
    let reads = 0;
    // No one-byte EOF probe: even an appended byte must not exceed the caller's
    // exact ceiling. Read precisely initial stat size; later fstat detects growth.
    while (report.bytesRead < size) {
      check(); if (reads >= maxReads) throw Error("read-limit");
      const length = Math.min(buffer.length, size - report.bytesRead);
      reads++;
      const { bytesRead } = await file.handle.read(buffer, 0, length, report.bytesRead);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) throw Error("invalid-read");
      report.bytesRead += bytesRead;
      check();
      if (bytesRead === 0) throw Error("early-eof");
      hash.update(buffer.subarray(0, bytesRead));
    }
    for (const { path, handle, before } of [...held].reverse()) {
      check(); const after = await handle.stat({ bigint: true });
      check(); const pathAfter = await io.lstat(path, { bigint: true }); check();
      if (!same(before, after) || !same(before, pathAfter)) throw Error("path-unstable");
    }
    check(); digest = hash.digest("hex");
    report.stability = "unchanged-at-checks";
  } catch (error) {
    const reason = error instanceof Error && ["deadline", "unsupported-type", "path-unstable",
      "unsupported-metadata", "byte-limit", "read-limit", "invalid-read", "early-eof"].includes(error.message)
      ? error.message : "io-unobserved";
    report.reasons.push(reason);
    if (reason === "path-unstable") report.stability = "unstable";
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => handle.close())));
    if (closed.some(x => x.status === "rejected")) report.reasons.push("close-unobserved");
  }
  try { check(); } catch { if (!report.reasons.includes("deadline")) report.reasons.push("deadline"); }
  report.complete = report.stability === "unchanged-at-checks" && report.reasons.length === 0;
  if (report.complete) report.sha256 = digest;
  return report;
}
