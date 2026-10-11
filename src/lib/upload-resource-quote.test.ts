import assert from "node:assert/strict";
import test from "node:test";
import { quoteUploadResources } from "./upload-resource-quote";

const identity = () => ({ database: "db-fixture", schema: "public", namespace: "/owned/fixture",
  quotaDomain: "quota-fixture", policyVersion: "policy-1", writerGeneration: "generation-1" });
const policy = () => ({ identity: identity(), layout: "provisioned-root-one-directory-one-file-v1",
  allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
  allAllocationCostsBounded: true, maxFileBytes: 104857600, allocationUnitBytes: 4096,
  allocationCopies: 1, directoryAndParentBytes: 8192, metadataBytes: 1024,
  temporaryBytes: 2048, additionalObjects: 0 });

test("quote accounts crossing byte, rounded allocation, all overhead and two objects", () => {
  assert.deepEqual(quoteUploadResources(policy(), identity()), {
    kind: "upload-resource-quote-only", identity: identity(), maxFileBytes: 104857600,
    logicalFileBytes: 104857601, allocatedBytes: 104872960, objects: 2,
  });
});

test("exact allocation boundary and crossing boundary; even zero payload costs resources", () => {
  for (const [limit, expected] of [[0, 4096], [4095, 4096], [4096, 8192]]) {
    const q = quoteUploadResources({ ...policy(), maxFileBytes: limit,
      directoryAndParentBytes: 0, metadataBytes: 0, temporaryBytes: 0 }, identity())!;
    assert.equal(q.allocatedBytes, expected);
    assert.equal(q.objects, 2);
  }
});

test("audited copies and additional objects remain independent resource dimensions", () => {
  const q = quoteUploadResources({ ...policy(), maxFileBytes: 6, allocationUnitBytes: 4,
    allocationCopies: 3, directoryAndParentBytes: 10, metadataBytes: 11,
    temporaryBytes: 12, additionalObjects: 3 }, identity())!;
  assert.equal(q.allocatedBytes, 57);
  assert.equal(q.objects, 5);
});

test("every identity component must be present, valid, and exactly matched on both sides", () => {
  for (const key of Object.keys(identity())) {
    for (const value of [undefined, null, "", " ", "bad\nname", " name", "x".repeat(513), 1, "different"]) {
      assert.equal(quoteUploadResources({ ...policy(), identity: { ...identity(), [key]: value } }, identity()), null);
      assert.equal(quoteUploadResources(policy(), { ...identity(), [key]: value }), null);
    }
  }
  // No equivalence via path cleanup or case-folding.
  assert.equal(quoteUploadResources({ ...policy(), identity: { ...identity(), namespace: "/owned/./fixture" } }, identity()), null);
});

test("unknown layout/model/ownership or missing bounding assertions deny", () => {
  for (const key of ["layout", "allocationModel", "stableExclusiveNamespace", "allAllocationCostsBounded"]) {
    for (const value of [undefined, null, false, 1, "unknown"]) {
      assert.equal(quoteUploadResources({ ...policy(), [key]: value }, identity()), null);
    }
  }
});

test("all numeric policy inputs reject missing, coerced, negative, fractional and unsafe values", () => {
  for (const key of ["maxFileBytes", "allocationUnitBytes", "allocationCopies", "directoryAndParentBytes",
    "metadataBytes", "temporaryBytes", "additionalObjects"]) {
    for (const value of [undefined, null, "0", true, -1, -0, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n]) {
      assert.equal(quoteUploadResources({ ...policy(), [key]: value }, identity()), null, key);
    }
  }
  for (const key of ["allocationUnitBytes", "allocationCopies"]) {
    assert.equal(quoteUploadResources({ ...policy(), [key]: 0 }, identity()), null);
  }
});

test("safe integer edge is exact; logical, rounding, product, sum and object overflow deny", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const p = { ...policy(), allocationUnitBytes: 1, directoryAndParentBytes: 0,
    metadataBytes: 0, temporaryBytes: 0, maxFileBytes: max - 1, additionalObjects: max - 2 };
  const q = quoteUploadResources(p, identity())!;
  assert.equal(q.logicalFileBytes, max);
  assert.equal(q.allocatedBytes, max);
  assert.equal(q.objects, max);
  for (const change of [{ maxFileBytes: max }, { allocationUnitBytes: 2 },
    { allocationCopies: 2 }, { directoryAndParentBytes: 1 }, { metadataBytes: 1 },
    { temporaryBytes: 1 }, { additionalObjects: max - 1 }]) {
    assert.equal(quoteUploadResources({ ...p, ...change }, identity()), null);
  }
});

test("plain-data validation denies accessors and inherited policy without executing getters", () => {
  let reads = 0;
  const p = Object.defineProperty(policy(), "metadataBytes", { get() { reads++; return 0; } });
  assert.equal(quoteUploadResources(p, identity()), null);
  const id = Object.defineProperty(identity(), "namespace", { get() { reads++; return "/owned/fixture"; } });
  assert.equal(quoteUploadResources(policy(), id), null);
  assert.equal(reads, 0);
  assert.equal(quoteUploadResources(Object.create(policy()), identity()), null);
  for (const value of [undefined, null, [], 1, "policy", new Date()]) {
    assert.equal(quoteUploadResources(value, identity()), null);
    assert.equal(quoteUploadResources(policy(), value), null);
  }
});

test("result owns an immutable identity snapshot; inputs unchanged and repeated quotes are not grants", () => {
  const p = policy(), expected = identity(), before = structuredClone(p);
  const q = quoteUploadResources(p, expected)!;
  assert.deepEqual(p, before);
  assert.ok(Object.isFrozen(q)); assert.ok(Object.isFrozen(q.identity));
  p.identity.namespace = "/changed"; expected.quotaDomain = "changed";
  assert.equal(q.identity.namespace, "/owned/fixture");
  assert.equal(q.identity.quotaDomain, "quota-fixture");
  assert.deepEqual(quoteUploadResources(before, identity()), q);
  assert.notEqual(quoteUploadResources(before, identity()), q);
});
