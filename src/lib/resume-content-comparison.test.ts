import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { observeUploadBlobContent } from "./resume-blob-content-observation";
import { compareUploadReferenceContent as compare, type KeyedContentObservation } from "./resume-content-comparison";
import type { ReferenceObservation } from "./resume-reference-inventory";

const key = "a".repeat(64), digest = "b".repeat(64), ns = "fixture:uploads:v1";
const reference: ReferenceObservation = { messageId: 1, roomId: "room123", storageKey: key,
  status: "reference", metadataStatus: "valid", declaredSize: 3, declaredSha256: digest };
const observed: KeyedContentObservation = { namespaceId: ns, storageKey: key,
  content: { complete: true, stability: "unchanged-at-checks", metadata: { sizeBytes: "3", linkCount: "1" },
    bytesRead: 3, sha256: digest, reasons: [], crossStoreStability: "unproven" } };
const unknown = { size: "unobserved", digest: "unobserved", crossStoreStability: "unproven", fullIdentity: "unobserved" };

test("completed explicit pair compares claims, without authority or input mutation", () => {
  const before = JSON.stringify({ reference, observed });
  assert.deepEqual(compare(reference, ns, observed), { ...unknown, size: "match", digest: "match" });
  assert.equal(JSON.stringify({ reference, observed }), before);
});
test("size and digest conflicts are independent", () => {
  assert.deepEqual(compare({ ...reference, declaredSize: 4 }, ns, observed), { ...unknown, size: "conflict", digest: "match" });
  assert.deepEqual(compare({ ...reference, declaredSha256: key }, ns, observed), { ...unknown, size: "match", digest: "conflict" });
  assert.deepEqual(compare({ ...reference, declaredSize: 4, declaredSha256: key }, ns, observed),
    { ...unknown, size: "conflict", digest: "conflict" });
});
test("wrong or missing namespace never joins equal keys", () => {
  for (const namespaceId of [null, "", "other", "x".repeat(129), " fixture", "fixture\n", "/uploads"])
    assert.deepEqual(compare(reference, namespaceId, observed), unknown);
  assert.deepEqual(compare(reference, ns, { ...observed, namespaceId: "other" }), unknown);
  for (const namespaceId of [ns + "\n", "a".repeat(129), "../uploads", ""])
    assert.deepEqual(compare(reference, namespaceId, { ...observed, namespaceId }), unknown);
});
test("keys are exact canonical identities, not normalized paths", () => {
  for (const storageKey of [null, "b".repeat(64), key.toUpperCase(), key + "\n", "../" + key]) {
    assert.deepEqual(compare({ ...reference, storageKey }, ns, observed), unknown);
    if (storageKey !== null) assert.deepEqual(compare(reference, ns, { ...observed, storageKey }), unknown);
  }
});
test("incomplete, unstable, errored or absent observations never mean absence or match", () => {
  assert.deepEqual(compare(reference, ns, null), unknown);
  for (const changed of [{ complete: false }, { stability: "unstable" as const },
    { stability: "unobserved" as const }, { reasons: ["deadline"] }, { sha256: null }, { metadata: null }])
    assert.deepEqual(compare(reference, ns, { ...observed, content: { ...observed.content, ...changed } }), unknown);
});
test("inconsistent measured counts and metadata fail closed", () => {
  for (const bytesRead of [0, 2, 4, -1, NaN, Infinity, 3.5, 67108865])
    assert.deepEqual(compare(reference, ns, { ...observed, content: { ...observed.content, bytesRead } }), unknown);
  for (const sizeBytes of ["03", "-3", "3.0", "3\n", "9007199254740993", "", "4"])
    assert.deepEqual(compare(reference, ns, { ...observed, content: { ...observed.content,
      metadata: { sizeBytes, linkCount: "1" } } }), unknown);
  assert.deepEqual(compare(reference, ns, { ...observed, content: { ...observed.content,
    metadata: { sizeBytes: "3", linkCount: "2" } } }), unknown);
});
test("bad measured digests cannot be accepted as completed content", () => {
  for (const sha256 of ["", digest.toUpperCase(), digest + "\n", "g".repeat(64)])
    assert.deepEqual(compare(reference, ns, { ...observed, content: { ...observed.content, sha256 } }), unknown);
});
test("unknown declarations remain independent, never coerced", () => {
  for (const declaredSize of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(compare({ ...reference, declaredSize }, ns, observed), { ...unknown, digest: "match" });
  for (const declaredSha256 of [undefined, "", digest.toUpperCase(), digest + "\n"])
    assert.deepEqual(compare({ ...reference, declaredSha256 }, ns, observed), { ...unknown, size: "match" });
});
test("tombstone, unknown, oversized and invalid references stay unobserved", () => {
  for (const status of ["tombstone", "non-file", "oversized", "invalid"] as const)
    assert.deepEqual(compare({ ...reference, status }, ns, observed), unknown);
  for (const metadataStatus of ["invalid", "unobserved", "not-applicable"] as const)
    assert.deepEqual(compare({ ...reference, metadataStatus }, ns, observed), unknown);
});
test("duplicate references keep independent contradictory evidence and unknowns", () => {
  const rows = [reference, { ...reference, declaredSize: 4 }, { ...reference, storageKey: null }, reference];
  assert.deepEqual(rows.map(row => compare(row, ns, observed).size), ["match", "conflict", "unobserved", "match"]);
  const second = { ...observed, content: { ...observed.content, sha256: key } };
  assert.deepEqual([observed, second].map(item => compare(reference, ns, item).digest), ["match", "conflict"]);
});
test("zero measured bytes can match only an explicitly completed empty-file observation", () => {
  const empty = { ...observed, content: { ...observed.content, bytesRead: 0,
    metadata: { sizeBytes: "0", linkCount: "1" } } };
  assert.equal(compare({ ...reference, declaredSize: 0 }, ns, empty).size, "match");
  assert.deepEqual(compare({ ...reference, declaredSize: 0 }, ns,
    { ...empty, content: { ...empty.content, complete: false } }), unknown);
});

for (const payload of [Buffer.from("abc"), Buffer.alloc(0)]) {
  test(`real ${payload.length}-byte observation compares with declared SHA-256 without a live volume`, async () => {
    // Only this isolated fixture setup/teardown writes; the comparator is pure.
    const root = await fs.mkdtemp(join(tmpdir(), "dimle-content-compare-"));
    try {
      await fs.mkdir(join(root, key));
      await fs.writeFile(join(root, key, "blob"), payload);
      const content = await observeUploadBlobContent(root, key,
        { maxBytes: payload.length, maxReads: 1, maxMs: 1000, trustedStableAncestry: true });
      assert.equal(content.complete, true);
      const ref = { ...reference, declaredSize: payload.length,
        declaredSha256: createHash("sha256").update(payload).digest("hex") };
      assert.deepEqual(compare(ref, ns, { namespaceId: ns, storageKey: key, content }),
        { ...unknown, size: "match", digest: "match" });
      assert.equal((await fs.readFile(join(root, key, "blob"))).equals(payload), true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
