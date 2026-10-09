import test from "node:test";
import assert from "node:assert/strict";
import { serializeUploadEvidence as serialize, type UploadEvidenceSources } from "./resume-evidence-envelope";

const p = { observationId: "scan-1", namespaceId: "uploads:v1", releaseSha: "a".repeat(40),
  startedAt: "2026-10-09T23:00:00.000Z", finishedAt: "2026-10-09T23:00:01.000Z" };
function fixture(): UploadEvidenceSources {
  return {
    database: { provenance: { ...p, databaseId: "db-1", schemaId: "schema-8" }, report: {
      scope: "database-only", complete: false, reasons: ["row-limit"], accounting: "unknown",
      budget: null, attempts: [], observedReservedBytes: "0", startedAt: p.startedAt, finishedAt: p.finishedAt,
      lastStorageKey: null, unobserved: ["filesystem"], crossStoreStability: "unproven",
      limits: { pageSize: 10, maxRows: 10, timeoutMs: 1000 },
      references: { receipts: [], messages: [], complete: false, parseComplete: false, metadataComplete: false, reasons: [] } } },
    root: { provenance: { ...p, volumeId: "vol-1", rootId: "root-1" },
      limits: { maxEntries: 10, maxMs: 1000, trustedStableAncestry: true },
      report: { entries: [], enumerationComplete: false, rootStability: "unobserved", reasons: ["io-unobserved"],
        blobs: "unobserved", crossStoreStability: "unproven" } },
    content: { provenance: { ...p, volumeId: "vol-1", rootId: "root-1" },
      limits: { namespaceId: p.namespaceId, trustedRootNamespaceBinding: true, trustedStableAncestry: true,
        maxKeys: 10, maxBytes: 100, maxReads: 10, maxMs: 1000, perKeyBytes: 10, perKeyReads: 1 },
      report: { observations: [], reservedBytes: 0, reservedReads: 0, allKeysAttempted: true,
        reasons: [], crossStoreStability: "unproven" } },
  };
}
function read(input: UploadEvidenceSources) {
  const result = serialize(input); assert.equal(result.ok, true);
  if (!result.ok) throw Error();
  return { json: result.json, value: JSON.parse(result.json) };
}
test("complete supplied-key batch never becomes complete volume or DB evidence", () => {
  const input = fixture(), { value } = read(input);
  assert.deepEqual(value.sources, input);
  assert.equal(value.sources.content.report.allKeysAttempted, true);
  assert.equal(value.sources.database.report.complete, false);
  assert.equal(value.sources.root.report.enumerationComplete, false);
  assert.equal(value.volumeCoverage, "unproven");
  assert.equal(value.crossStoreStability, "unproven");
  assert.equal(value.authority, "none");
  for (const key of ["complete", "pass", "absent", "owned", "reclaimable"]) assert.equal(key in value, false);
});
test("original duplicate and contradictory references remain in source order", () => {
  const input = fixture();
  const row = { messageId: 1, roomId: "room123", storageKey: "a".repeat(64),
    status: "reference" as const, metadataStatus: "valid" as const, declaredSize: 3 };
  input.database!.report.references!.messages = [row, { ...row, declaredSize: 4 }, row];
  input.database!.report.references!.receipts = [{ ...row, status: "tombstone", storageKey: null }];
  assert.deepEqual(read(input).value.sources, input);
});
test("duplicate content observations, failed attempts and input indices survive", () => {
  const input = fixture();
  const item = { namespaceId: p.namespaceId, storageKey: "a".repeat(64), inputIndex: 0,
    content: { complete: false, stability: "unobserved" as const, metadata: null,
      bytesRead: 0, sha256: null, reasons: ["io-unobserved"], crossStoreStability: "unproven" as const } };
  input.content!.report.observations = [item, { ...item, inputIndex: 1 }];
  assert.deepEqual(read(input).value.sources, input);
});
test("missing sources stay null, never synthesized as empty complete scans", () => {
  const { value } = read({ database: null, root: null, content: null });
  assert.deepEqual(value.sources, { database: null, root: null, content: null });
  assert.equal(value.volumeCoverage, "unproven");
});
test("independent DB/schema/release/root namespaces are retained, never joined", () => {
  const input = fixture();
  input.database!.provenance.namespaceId = "old:uploads";
  input.database!.provenance.releaseSha = "b".repeat(40);
  input.root!.provenance.rootId = "other-root";
  const { value } = read(input);
  assert.deepEqual(value.sources, input);
  assert.equal(value.provenance, "caller-asserted-unverified");
  assert.equal(value.relationship, "independent-observations");
});
test("capture is immutable after caller changes reports or provenance", () => {
  const input = fixture(), { json } = read(input);
  input.content!.report.allKeysAttempted = false;
  input.database!.provenance.databaseId = "new-db";
  assert.equal(JSON.parse(json).sources.content.report.allKeysAttempted, true);
  assert.equal(JSON.parse(json).sources.database.provenance.databaseId, "db-1");
});
test("invalid identity, time and contradictory within-source namespace are rejected", () => {
  for (const change of [
    (x: UploadEvidenceSources) => { x.database!.provenance.databaseId = "postgres://secret"; },
    (x: UploadEvidenceSources) => { x.root!.provenance.releaseSha += "\n"; },
    (x: UploadEvidenceSources) => { x.root!.provenance.startedAt = "invalid"; },
    (x: UploadEvidenceSources) => { x.root!.provenance.finishedAt = "2020-01-01T00:00:00.000Z"; },
    (x: UploadEvidenceSources) => { x.content!.limits.namespaceId = "other"; },
  ]) { const input = fixture(); change(input); assert.equal(serialize(input).ok, false); }
});
test("bounds reject instead of truncating source evidence", () => {
  const input = fixture();
  input.root!.report.entries = Array.from({ length: 10001 }, () => ({ storageKey: null, kind: "unobserved" as const }));
  assert.equal(serialize(input).ok, false);
  input.root!.report.entries = [];
  input.database!.report.reasons = ["x".repeat(4097)];
  assert.equal(serialize(input).ok, false);
  input.database!.report.reasons = Array(3000).fill("x".repeat(4096));
  assert.equal(serialize(input).ok, false);
});
test("accessors and toJSON cannot execute; cycles and nonfinite values fail closed", () => {
  const input = fixture(); let calls = 0;
  Object.defineProperty(input.root!.report, "entries", { enumerable: true, get() { calls++; return []; } });
  assert.equal(serialize(input).ok, false); assert.equal(calls, 0);
  const other = fixture();
  Object.assign(other.root!.report, { toJSON() { calls++; return {}; } });
  assert.equal(serialize(other).ok, false); assert.equal(calls, 0);
  Object.assign(other.root!.report, { toJSON: other });
  assert.equal(serialize(other).ok, false);
  const third = fixture(); third.content!.report.reservedBytes = NaN;
  assert.equal(serialize(third).ok, false);
});
test("all source completion flags still grant no cross-store snapshot or authority", () => {
  const input = fixture();
  input.database!.report.complete = true;
  Object.assign(input.database!.report.references!, { complete: true, parseComplete: true, metadataComplete: true });
  Object.assign(input.root!.report, { enumerationComplete: true, rootStability: "unchanged-at-checks", reasons: [] });
  const { value } = read(input);
  assert.deepEqual(value.sources, input);
  assert.equal(value.crossStoreStability, "unproven");
  assert.equal(value.volumeCoverage, "unproven");
  assert.equal(value.authority, "none");
  assert.equal("complete" in value, false);
});
test("node and depth budgets reject before producing an envelope", () => {
  const input = fixture();
  let nested: object = {};
  for (let i = 0; i < 25; i++) nested = { nested };
  Object.assign(input.root!.report, { nested });
  assert.equal(serialize(input).ok, false);
  const other = fixture();
  // Under the byte/array/string limits but above the total visited-node limit.
  Object.assign(other.root!.report, { extra: Array(100000).fill([0, 0, 0, 0, 0]) });
  assert.equal(serialize(other).ok, false);
});
test("JSON escaping and multibyte text round-trip without silent normalization", () => {
  const input = fixture();
  input.database!.report.reasons = ["line\nquote\"\\", "zażółć", "😀"];
  const { value, json } = read(input);
  assert.deepEqual(value.sources, input);
  assert.ok(Buffer.byteLength(json) < 8 * 1024 * 1024);
});
