import assert from "node:assert/strict";
import test from "node:test";
import { quoteUploadResources, quoteStrictUploadResources } from "./upload-resource-quote";
import { pinUploadResourcePolicy, recheckUploadResourcePolicy,
  pinStrictUploadResourcePolicy, recheckStrictUploadResourcePolicy } from "./upload-resource-policy-pin";

const identity = () => ({ database: "fixture-cluster/db", schema: "fixture", namespace: "/owned/fixture",
  quotaDomain: "fixture-volume", policyVersion: "v1", writerGeneration: "g1" });
const policy = () => ({ identity: identity(), adapter: "resume-strict-writer-v1",
  layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
  stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 4096,
  allocationUnitBytes: 4096, allocationCopies: 1, directoryAndParentBytes: 8192,
  metadataBytes: 1024, temporaryBytes: 2048, additionalObjects: 0 });

test("strict L versus unchanged Multer L+1 at zero and allocation boundaries", () => {
  for (const [limit, strict, multer] of [[0, 0, 4096], [4095, 4096, 4096], [4096, 4096, 8192]]) {
    const p = { ...policy(), maxFileBytes: limit, directoryAndParentBytes: 0, metadataBytes: 0, temporaryBytes: 0 };
    const q = quoteStrictUploadResources(p, identity())!;
    assert.equal(q.logicalFileBytes, limit);
    assert.equal(q.allocatedBytes, strict);
    assert.equal(q.objects, 2); // zero data does not remove directory/file liability
    assert.equal(quoteUploadResources(p, identity())!.allocatedBytes, multer);
    assert.equal(quoteUploadResources(p, identity())!.logicalFileBytes, limit + 1);
  }
});

test("strict copies, directory/parent, metadata, temporary and objects are still charged", () => {
  const p = { ...policy(), allocationCopies: 3, additionalObjects: 4 };
  const q = quoteStrictUploadResources(p, identity())!;
  assert.equal(q.allocatedBytes, 3 * 4096 + 8192 + 1024 + 2048);
  assert.equal(q.objects, 6);
});

test("strict quote and pin reject missing, mismatched and unknown adapter", () => {
  for (const adapter of [undefined, null, "multer-crossing-byte-v1", "private-raw-writer", "future", 1]) {
    const p = { ...policy(), adapter };
    assert.equal(quoteStrictUploadResources(p, identity()), null);
    assert.equal(pinStrictUploadResourcePolicy(p, identity()), null);
  }
  assert.equal(pinUploadResourcePolicy(policy(), identity()), null);
});

test("registries reject cross-adapter pins even with equal rounded cost", () => {
  const p = { ...policy(), maxFileBytes: 6 }, m = { ...p, adapter: "multer-crossing-byte-v1" };
  const strict = pinStrictUploadResourcePolicy(p, identity())!, multer = pinUploadResourcePolicy(m, identity())!;
  assert.equal(recheckStrictUploadResourcePolicy(strict, p)!.quote.allocatedBytes,
    recheckUploadResourcePolicy(multer, m)!.quote.allocatedBytes);
  assert.equal(recheckUploadResourcePolicy(strict, m), null);
  assert.equal(recheckStrictUploadResourcePolicy(multer, p), null);
  assert.equal(recheckStrictUploadResourcePolicy(strict, m), null);
  assert.equal(recheckUploadResourcePolicy(multer, p), null);
});

test("strict safe-integer limit is exact; rounding, product, overhead and object overflow deny", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const p = { ...policy(), maxFileBytes: max, allocationUnitBytes: 1,
    directoryAndParentBytes: 0, metadataBytes: 0, temporaryBytes: 0, additionalObjects: max - 2 };
  const q = quoteStrictUploadResources(p, identity())!;
  assert.equal(q.logicalFileBytes, max); assert.equal(q.allocatedBytes, max); assert.equal(q.objects, max);
  assert.equal(quoteUploadResources(p, identity()), null);
  for (const change of [{ maxFileBytes: max + 1 }, { allocationUnitBytes: 2 }, { allocationCopies: 2 },
    { directoryAndParentBytes: 1 }, { metadataBytes: 1 }, { temporaryBytes: 1 }, { additionalObjects: max - 1 }]) {
    assert.equal(quoteStrictUploadResources({ ...p, ...change }, identity()), null);
    assert.equal(pinStrictUploadResourcePolicy({ ...p, ...change }, identity()), null);
  }
});

test("strict incomplete, unbounded, invalid and mismatched identity policies fail closed", () => {
  for (const key of Object.keys(policy())) {
    const p: Record<string, unknown> = { ...policy() }; delete p[key];
    assert.equal(quoteStrictUploadResources(p, identity()), null, key);
    assert.equal(pinStrictUploadResourcePolicy(p, identity()), null, key);
  }
  for (const key of ["stableExclusiveNamespace", "allAllocationCostsBounded"]) {
    assert.equal(pinStrictUploadResourcePolicy({ ...policy(), [key]: false }, identity()), null);
  }
  for (const key of Object.keys(identity())) {
    assert.equal(pinStrictUploadResourcePolicy({ ...policy(), identity: { ...identity(), [key]: "changed" } }, identity()), null);
  }
  for (const key of ["maxFileBytes", "allocationUnitBytes", "allocationCopies", "directoryAndParentBytes",
    "metadataBytes", "temporaryBytes", "additionalObjects"]) {
    for (const value of [-1, -0, 0.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(pinStrictUploadResourcePolicy({ ...policy(), [key]: value }, identity()), null, key);
    }
  }
});

test("strict snapshot ignores supplied costs and owns frozen policy across await", async () => {
  const p = { ...policy(), allocatedBytes: 0, quote: { objects: 0 } }, original = structuredClone(p);
  const pin = pinStrictUploadResourcePolicy(p, identity())!;
  await Promise.resolve();
  p.identity.namespace = "/changed"; p.metadataBytes++;
  assert.equal(recheckStrictUploadResourcePolicy(pin, p), null);
  const result = recheckStrictUploadResourcePolicy(pin, original)!;
  assert.equal(result.quote.logicalFileBytes, 4096);
  assert.equal(result.quote.allocatedBytes, 15360);
  assert.equal(result.policy.allocatedBytes, undefined); assert.equal(result.policy.quote, undefined);
  for (const value of [pin, result, result.policy, result.policy.identity, result.quote, result.quote.identity]) {
    assert.ok(Object.isFrozen(value));
  }
});

test("strict recheck rejects every changed policy input including equal-cost permutations", () => {
  const p = policy(), pin = pinStrictUploadResourcePolicy(p, identity())!;
  for (const [key, value] of Object.entries(p)) {
    const changed = typeof value === "number" ? value + 1 : typeof value === "boolean" ? false : "changed";
    assert.equal(recheckStrictUploadResourcePolicy(pin, { ...p, [key]: changed }), null, key);
  }
  for (const key of Object.keys(identity())) {
    assert.equal(recheckStrictUploadResourcePolicy(pin, { ...p, identity: { ...identity(), [key]: "changed" } }), null);
  }
  assert.equal(recheckStrictUploadResourcePolicy(pin, { ...p, metadataBytes: 2048, temporaryBytes: 1024 }), null);
});

test("strict pins cannot be copied or forged; getters and inherited data never supply policy", () => {
  const p = policy(), pin = pinStrictUploadResourcePolicy(p, identity())!;
  for (const fake of [undefined, null, 0, {}, { ...pin }, JSON.parse(JSON.stringify(pin))]) {
    assert.equal(recheckStrictUploadResourcePolicy(fake, p), null);
  }
  let reads = 0;
  for (const key of Object.keys(p)) {
    const accessor = Object.defineProperty(policy(), key, { get() { reads++; return p[key as keyof typeof p]; } });
    assert.equal(quoteStrictUploadResources(accessor, identity()), null);
    assert.equal(pinStrictUploadResourcePolicy(accessor, identity()), null);
  }
  assert.equal(pinStrictUploadResourcePolicy(Object.create(p), identity()), null);
  assert.equal(reads, 0);
});
