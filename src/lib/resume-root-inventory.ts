import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";

export type RootInventory = {
  entries: { storageKey: string | null; kind: "directory" | "file" | "symlink" | "other" | "unobserved" }[];
  enumerationComplete: boolean;
  rootStability: "unchanged-at-checks" | "unstable" | "unobserved";
  reasons: string[];
  blobs: "unobserved"; crossStoreStability: "unproven";
};
const same = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
  a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// PRIVATE, no runtime caller. Root AND all ancestors must be trusted, stable,
// server-owned directories. Path checks cannot defend against hostile same-uid
// rename/ABA races. The deadline bounds admission of I/O, not kernel I/O latency.
// Never descends into an entry, reads a blob, mutates storage or infers absence.
export async function inventoryUploadRoot(root: string,
  limits: { maxEntries: number; maxMs: number; trustedStableAncestry: boolean },
  io: Pick<typeof fs, "open" | "opendir" | "lstat"> = fs,
  now: () => number = () => performance.now(),
): Promise<RootInventory> {
  const report: RootInventory = { entries: [], enumerationComplete: false,
    rootStability: "unobserved", reasons: [], blobs: "unobserved", crossStoreStability: "unproven" };
  const { maxEntries, maxMs, trustedStableAncestry } = limits;
  if (!isAbsolute(root) || trustedStableAncestry !== true ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000 ||
      !Number.isSafeInteger(maxMs) || maxMs < 1 || maxMs > 30000) {
    report.reasons.push("invalid-contract"); return report;
  }
  const started = now(), deadline = started + maxMs;
  let last = started;
  const check = () => { const time = now();
    if (!Number.isFinite(started) || !Number.isFinite(time) || time < last || time >= deadline) throw Error("deadline");
    last = time;
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  let exhausted = false;
  const seen = new Set<string>();
  try {
    check();
    handle = await io.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    check(); const before = await handle.stat({ bigint: true });
    check(); const pathBefore = await io.lstat(root, { bigint: true });
    if (!before.isDirectory() || !same(before, pathBefore)) throw Error("root-unstable");
    check(); directory = await io.opendir(root, { bufferSize: 1 });
    check(); const opened = await io.lstat(root, { bigint: true });
    if (!same(before, opened)) throw Error("root-unstable");
    while (true) {
      check(); const entry = await directory.read(); check();
      if (entry === null) { exhausted = true; break; }
      if (report.entries.length === maxEntries) { report.reasons.push("entry-limit"); break; }
      // Do not return unknown names (which can contain private information).
      const name = entry.name;
      const storageKey = name.length === 64 && /^[a-f0-9]{64}$/.test(name) ? name : null;
      const item: RootInventory["entries"][number] = { storageKey, kind: "unobserved" };
      report.entries.push(item);
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name) ||
          Buffer.byteLength(name) > 255 || seen.has(name)) {
        report.reasons.push("invalid-or-duplicate-entry"); break;
      }
      seen.add(name);
      if (storageKey === null) report.reasons.push("unknown-entry");
      try {
        check(); const stat = await io.lstat(join(root, name), { bigint: true }); check();
        item.kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" :
          stat.isFile() ? "file" : "other";
        if (item.kind === "symlink" || item.kind === "other") report.reasons.push("unsupported-entry");
      } catch (error) {
        if (error instanceof Error && error.message === "deadline") throw error;
        report.reasons.push("entry-unobserved");
      }
    }
    check(); const after = await handle.stat({ bigint: true });
    check(); const pathAfter = await io.lstat(root, { bigint: true }); check();
    report.rootStability = same(before, after) && same(before, pathAfter)
      ? "unchanged-at-checks" : "unstable";
    if (report.rootStability === "unstable") report.reasons.push("root-unstable");
  } catch (error) {
    const reason = error instanceof Error && ["deadline", "root-unstable"].includes(error.message)
      ? error.message : "io-unobserved";
    report.reasons.push(reason);
    if (reason === "root-unstable") report.rootStability = "unstable";
  } finally {
    const closed = await Promise.allSettled([directory, handle].filter(x => x !== undefined)
      .map(x => Promise.resolve().then(() => x.close())));
    if (closed.some(x => x.status === "rejected")) report.reasons.push("close-unobserved");
  }
  try { check(); } catch { if (!report.reasons.includes("deadline")) report.reasons.push("deadline"); }
  report.enumerationComplete = exhausted && report.rootStability === "unchanged-at-checks" &&
    report.reasons.length === 0;
  report.reasons = [...new Set(report.reasons)];
  return report;
}
