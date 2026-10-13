import type { LedgerInventory } from "./resume-ledger-inventory";
import type { RootInventory } from "./resume-root-inventory";
import type { ContentBatch, ContentBatchContract } from "./resume-content-batch";

type Capture = {
  observationId: string; namespaceId: string; releaseSha: string;
  startedAt: string; finishedAt: string;
};
export type UploadEvidenceSources = {
  database: null | { provenance: Capture & { databaseId: string; schemaId: string }; report: LedgerInventory };
  root: null | { provenance: Capture & { volumeId: string; rootId: string };
    limits: { maxEntries: number; maxMs: number; trustedStableAncestry: boolean }; report: RootInventory };
  content: null | { provenance: Capture & { volumeId: string; rootId: string };
    limits: ContentBatchContract; report: ContentBatch };
};
export type UploadEvidenceEnvelope = {
  format: "dimle-upload-evidence-v1";
  provenance: "caller-asserted-unverified";
  relationship: "independent-observations";
  crossStoreStability: "unproven";
  volumeCoverage: "unproven";
  authority: "none";
  sources: UploadEvidenceSources;
};
const MAX_BYTES = 8 * 1024 * 1024;
const id = (x: unknown) => typeof x === "string" && x.length >= 1 && x.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(x);
const bounded = (x: number, max: number) => Number.isSafeInteger(x) && x >= 0 && x <= max;

// Internal bounded JSON encoding. No toJSON/getters, coercion, truncation or
// lossy undefined/NaN conversion. Trusted in-process plain collector data only;
// this is not a sandbox for hostile proxies. Repeated objects are NOT deduped.
function encode(value: unknown): string {
  let bytes = 0, nodes = 0;
  const pieces: string[] = [], ancestors = new Set<object>();
  const put = (s: string) => {
    bytes += Buffer.byteLength(s);
    if (bytes > MAX_BYTES) throw Error();
    pieces.push(s);
  };
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 500000 || depth > 24) throw Error();
    if (v === null || typeof v === "boolean") { put(JSON.stringify(v)); return; }
    if (typeof v === "string") {
      if (v.length > 4096) throw Error();
      put(JSON.stringify(v)); return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v) || Object.is(v, -0)) throw Error();
      put(JSON.stringify(v)); return;
    }
    if (typeof v !== "object" || ancestors.has(v)) throw Error();
    const array = Array.isArray(v);
    if (array ? Object.getPrototypeOf(v) !== Array.prototype :
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw Error();
    ancestors.add(v);
    if (array) {
      if (v.length > 100000) throw Error();
      put("[");
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) throw Error();
        if (i) put(",");
        visit(d.value, depth + 1);
      }
      // Reject enumerable non-index extras rather than silently losing them.
      let count = 0;
      for (const key in v) { if (!Object.hasOwn(v, key) || ++count > v.length) throw Error(); }
      if (count !== v.length) throw Error();
      put("]");
    } else {
      put("{");
      let count = 0;
      for (const key in v) {
        if (!Object.hasOwn(v, key) || key.length > 128 || ++count > 64) throw Error();
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d || !("value" in d)) throw Error();
        if (count > 1) put(",");
        put(JSON.stringify(key)); put(":"); visit(d.value, depth + 1);
      }
      put("}");
    }
    if (Object.getOwnPropertySymbols(v).length) throw Error();
    ancestors.delete(v);
  };
  visit(value, 0);
  return pieces.join("");
}

// PRIVATE, no I/O/runtime caller. Returns an immutable serialized capture, never
// a combined PASS, absence/ownership verdict or permission to repair. Original
// collector reports (including duplicates and all completeness axes) survive.
// Provenance is supplied by the collector owner, NOT verified by this function.
export function serializeUploadEvidence(sources: UploadEvidenceSources):
  { ok: true; json: string } | { ok: false; reason: "invalid-or-over-budget" } {
  try {
    const envelope: UploadEvidenceEnvelope = { format: "dimle-upload-evidence-v1",
      provenance: "caller-asserted-unverified", relationship: "independent-observations",
      crossStoreStability: "unproven", volumeCoverage: "unproven", authority: "none", sources };
    // Snapshot first, so subsequent validation never invokes caller getters.
    const json = encode(envelope);
    const copy = (JSON.parse(json) as UploadEvidenceEnvelope).sources;
    for (const name of ["database", "root", "content"] as const) {
      const source = copy[name];
      if (source === null) continue;
      const p = source.provenance;
      if (!id(p.observationId) || !id(p.namespaceId) || typeof p.releaseSha !== "string" ||
          p.releaseSha.length !== 40 || !/^[a-f0-9]{40}$/.test(p.releaseSha) ||
          ![p.startedAt, p.finishedAt].every(t => typeof t === "string" &&
            Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t) ||
          p.finishedAt < p.startedAt) throw Error();
      if (source.report.crossStoreStability !== "unproven") throw Error();
    }
    const db = copy.database, root = copy.root, content = copy.content;
    if (db && (!id(db.provenance.databaseId) || !id(db.provenance.schemaId) ||
      !Array.isArray(db.report.attempts) || db.report.attempts.length > 100000 ||
      (db.report.references && (db.report.references.receipts.length > 100000 ||
        db.report.references.messages.length > 100000)))) throw Error();
    for (const source of [root, content]) {
      if (source && (!id(source.provenance.volumeId) || !id(source.provenance.rootId))) throw Error();
    }
    if (root && (!Array.isArray(root.report.entries) || root.report.entries.length > 10000 ||
      !bounded(root.limits.maxEntries, 10000) || !bounded(root.limits.maxMs, 30000))) throw Error();
    if (content && (!Array.isArray(content.report.observations) || content.report.observations.length > 1000 ||
      !id(content.limits.namespaceId) || content.limits.namespaceId !== content.provenance.namespaceId ||
      content.report.observations.some(o => o.namespaceId !== content.provenance.namespaceId))) throw Error();
    return { ok: true, json };
  } catch { return { ok: false, reason: "invalid-or-over-budget" }; }
}
