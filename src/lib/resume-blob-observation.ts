import fs, { type FileHandle } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";

export type BlobObservation = {
  metadata: { sizeBytes: string; linkCount: string } | null;
  stability: "unchanged-at-checks" | "unstable" | "unobserved";
  complete: boolean;
  reasons: string[];
  content: "unobserved";
  crossStoreStability: "unproven";
};
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// PRIVATE, no runtime caller. Trusted stable root AND ancestors are a caller
// precondition, not proven here. No hostile same-uid/ABA protection. Fixed-depth
// metadata only: never reads/hashes content, enumerates a directory or mutates.
// maxMs bounds I/O admission, NOT pending kernel I/O or close latency.
export async function observeUploadBlob(root: string, storageKey: string,
  limits: { maxMs: number; trustedStableAncestry: boolean },
  io: Pick<typeof fs, "open" | "lstat"> = fs,
  now: () => number = () => performance.now(),
): Promise<BlobObservation> {
  const report: BlobObservation = { metadata: null, stability: "unobserved", complete: false,
    reasons: [], content: "unobserved", crossStoreStability: "unproven" };
  const { maxMs, trustedStableAncestry } = limits;
  if (!isAbsolute(root) || trustedStableAncestry !== true ||
      typeof storageKey !== "string" || storageKey.length !== 64 || !/^[a-f0-9]{64}$/.test(storageKey) ||
      !Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 30000) {
    report.reasons.push("invalid-contract"); return report;
  }
  const started = now(), deadline = started + maxMs;
  const check = () => { const time = now();
    if (!Number.isFinite(started) || !Number.isFinite(time) || time < started || time >= deadline) throw Error("deadline"); };
  const held: { path: string; handle: FileHandle; before: BigIntStats }[] = [];
  const handles: FileHandle[] = [];
  try {
    for (const path of [root, join(root, storageKey), join(root, storageKey, "blob")]) {
      const blob = held.length === 2;
      check(); const prior = await io.lstat(path, { bigint: true }); check();
      if (blob ? !prior.isFile() : !prior.isDirectory()) throw Error("unsupported-type");
      // NONBLOCK also prevents a regular-file -> FIFO replacement from hanging
      // at open. fstat must STILL prove regular-file type before any use.
      check(); const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
        (blob ? constants.O_NONBLOCK : constants.O_DIRECTORY));
      handles.push(handle);
      check(); const before = await handle.stat({ bigint: true }); check();
      if (!same(prior, before) || (blob ? !before.isFile() : !before.isDirectory())) throw Error("path-unstable");
      held.push({ path, handle, before });
      if (blob) {
        if (before.size < 0n || before.nlink !== 1n) throw Error("unsupported-metadata");
        report.metadata = { sizeBytes: before.size.toString(), linkCount: before.nlink.toString() };
      }
    }
    // Include the root and keyed directory, not just the final file. These are
    // sequential checks, NOT a snapshot or authorization for later file access.
    for (const { path, handle, before } of [...held].reverse()) {
      check(); const after = await handle.stat({ bigint: true });
      check(); const pathAfter = await io.lstat(path, { bigint: true }); check();
      if (!same(before, after) || !same(before, pathAfter)) throw Error("path-unstable");
    }
    report.stability = "unchanged-at-checks";
  } catch (error) {
    const reason = error instanceof Error && ["deadline", "unsupported-type", "path-unstable", "unsupported-metadata"].includes(error.message)
      ? error.message : "io-unobserved";
    report.reasons.push(reason);
    if (reason === "path-unstable") report.stability = "unstable";
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()));
    if (closed.some(x => x.status === "rejected")) report.reasons.push("close-unobserved");
  }
  report.complete = report.stability === "unchanged-at-checks" && report.reasons.length === 0;
  // Earlier metadata is only an observation; never discard it on later failure
  // and never promote it to measured content integrity, ownership or capacity.
  return report;
}
