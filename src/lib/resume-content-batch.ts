import fs from "node:fs/promises";
import { isAbsolute } from "node:path";
import { observeUploadBlobContent } from "./resume-blob-content-observation";
import type { KeyedContentObservation } from "./resume-content-comparison";

export type ContentBatchContract = {
  namespaceId: string;
  trustedRootNamespaceBinding: boolean;
  trustedStableAncestry: boolean;
  maxKeys: number;
  maxBytes: number;
  maxReads: number;
  maxMs: number;
  perKeyBytes: number;
  perKeyReads: number;
};
export type ContentBatch = {
  observations: (KeyedContentObservation & { inputIndex: number })[];
  reservedBytes: number;
  reservedReads: number;
  allKeysAttempted: boolean;
  reasons: string[];
  crossStoreStability: "unproven";
};
const bounded = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;

// PRIVATE: supplied keys only, no enumeration or runtime caller. Caller retains
// original DB references, duplicates, provenance and source scan completeness.
// Binding flags are external assertions, not proof. No ownership/absence verdict.
// Reserve the FULL per-key allowance before I/O; never refund unused/failed work.
// Thus totals bound even ambiguous failed reads without trusting byte counters.
// Sequential, including awaited closes. Deadline is admission/completion only,
// NOT a hard bound on pending kernel I/O/close. Reads may update atime.
export async function observeUploadContentBatch(root: string, keys: readonly string[],
  contract: ContentBatchContract, io: Pick<typeof fs, "open" | "lstat"> = fs,
  now: () => number = () => performance.now(),
): Promise<ContentBatch> {
  const result: ContentBatch = { observations: [], reservedBytes: 0, reservedReads: 0,
    allKeysAttempted: false, reasons: [], crossStoreStability: "unproven" };
  const { namespaceId, trustedRootNamespaceBinding, trustedStableAncestry,
    maxKeys, maxBytes, maxReads, maxMs, perKeyBytes, perKeyReads } = contract;
  if (typeof root !== "string" || !isAbsolute(root) || trustedRootNamespaceBinding !== true ||
      trustedStableAncestry !== true || typeof namespaceId !== "string" ||
      namespaceId.length < 1 || namespaceId.length > 128 || !/^[A-Za-z0-9]/.test(namespaceId) ||
      /[^A-Za-z0-9._:-]/.test(namespaceId) || !bounded(maxKeys, 0, 1000) ||
      !bounded(maxBytes, 0, 64 * 1024 * 1024) || !bounded(maxReads, 0, 4096) ||
      !bounded(maxMs, 1, 30000) || !bounded(perKeyBytes, 0, 64 * 1024 * 1024) ||
      !bounded(perKeyReads, 1, 4096) || !Array.isArray(keys) || keys.length > maxKeys) {
    result.reasons.push("invalid-contract"); return result;
  }
  // Bound input work BEFORE copying; copy every key/contract before first await.
  const supplied: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== "string" || key.length !== 64 || !/^[a-f0-9]{64}$/.test(key)) {
      result.reasons.push("invalid-contract"); return result;
    }
    supplied.push(key);
  }
  const started = now(), deadline = started + maxMs;
  let last = started, clockInvalid = false;
  const clock = () => {
    const time = now();
    if (clockInvalid || !Number.isFinite(started) || !Number.isFinite(time) || time < last || time >= deadline) {
      clockInvalid = true; return NaN;
    }
    last = time; return time;
  };
  for (let i = 0; i < supplied.length; i++) {
    const remainingMs = Math.floor(deadline - clock());
    if (!Number.isFinite(remainingMs) || remainingMs < 1) { result.reasons.push("deadline"); return result; }
    if (perKeyBytes > maxBytes - result.reservedBytes || perKeyReads > maxReads - result.reservedReads) {
      result.reasons.push("total-budget"); return result;
    }
    result.reservedBytes += perKeyBytes;
    result.reservedReads += perKeyReads;
    const storageKey = supplied[i];
    const content = await observeUploadBlobContent(root, storageKey, {
      maxBytes: perKeyBytes, maxReads: perKeyReads, maxMs: remainingMs, trustedStableAncestry,
    }, io, clock);
    result.observations.push({ namespaceId, storageKey, inputIndex: i, content });
    // Failed/partial observations remain intact, but never admit more work after
    // a deadline or a clock anomaly (even if a test clock later recovers).
    if (content.reasons.includes("deadline") || !Number.isFinite(clock()) || last >= deadline) {
      result.reasons.push("deadline"); return result;
    }
  }
  const completed = clock();
  if (!Number.isFinite(completed) || completed >= deadline) result.reasons.push("deadline");
  else result.allKeysAttempted = true; // NOT all observations complete / scan PASS.
  return result;
}
