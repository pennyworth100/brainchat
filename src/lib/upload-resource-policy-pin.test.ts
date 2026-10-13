import assert from "node:assert/strict";
import test from "node:test";
import { pinUploadResourcePolicy, recheckUploadResourcePolicy } from "./upload-resource-policy-pin";

const identity = () => ({ database: "cluster-fixture/postgres", schema: "owned_fixture",
  namespace: "/fixture/a", quotaDomain: "shared-volume", policyVersion: "v1", writerGeneration: "g1" });
const policy = () => ({ identity: identity(), adapter: "multer-crossing-byte-v1",
  layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
  stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
  allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10,
  metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 });

test("pin recheck recomputes charges from policy, ignoring supplied quote/cost fields", () => {
  const p = { ...policy(), allocatedBytes: 0, objects: 0, quote: { allocatedBytes: 0 } };
  const pin = pinUploadResourcePolicy(p, identity())!;
  const result = recheckUploadResourcePolicy(pin, p)!;
  assert.equal(result.quote.logicalFileBytes, 7);
  assert.equal(result.quote.allocatedBytes, 41);
  assert.equal(result.quote.objects, 5);
  assert.equal(result.policy.allocatedBytes, undefined);
  assert.equal(result.policy.quote, undefined);
});

test("snapshot survives input changes across checkout await and denies changed current policy", async () => {
  const p = policy(), expected = identity(), original = structuredClone(p);
  const pin = pinUploadResourcePolicy(p, expected)!;
  await Promise.resolve();
  p.identity.namespace = "/fixture/b"; p.maxFileBytes = 100;
  expected.writerGeneration = "g2";
  assert.equal(recheckUploadResourcePolicy(pin, p), null);
  assert.deepEqual(recheckUploadResourcePolicy(pin, original)!.quote.identity, identity());
});

test("every identity component changing under the lock denies the old pin", () => {
  const pin = pinUploadResourcePolicy(policy(), identity())!;
  for (const key of Object.keys(identity())) {
    assert.equal(recheckUploadResourcePolicy(pin, { ...policy(), identity: { ...identity(), [key]: "different" } }), null);
  }
});

test("same total charge does not hide a changed allocation model input", () => {
  const pin = pinUploadResourcePolicy(policy(), identity())!;
  const changed = { ...policy(), metadataBytes: 12, temporaryBytes: 11 };
  assert.ok(pinUploadResourcePolicy(changed, identity()));
  assert.equal(recheckUploadResourcePolicy(pin, changed), null);
});

test("all cost inputs are rechecked, including changes within the same rounding bucket", () => {
  const p = policy(), pin = pinUploadResourcePolicy(p, identity())!;
  for (const key of ["maxFileBytes", "allocationUnitBytes", "allocationCopies", "directoryAndParentBytes",
    "metadataBytes", "temporaryBytes", "additionalObjects"] as const) {
    assert.equal(recheckUploadResourcePolicy(pin, { ...p, [key]: p[key] + 1 }), null, key);
  }
  for (const key of ["adapter", "layout", "allocationModel", "stableExclusiveNamespace", "allAllocationCostsBounded"]) {
    assert.equal(recheckUploadResourcePolicy(pin, { ...p, [key]: "unknown" }), null, key);
  }
});

test("fabricated, copied, serialized and primitive pins have no registered snapshot", () => {
  const pin = pinUploadResourcePolicy(policy(), identity())!;
  for (const fake of [null, undefined, 0, "pin", {}, { ...pin }, JSON.parse(JSON.stringify(pin))]) {
    assert.equal(recheckUploadResourcePolicy(fake, policy()), null);
  }
  assert.ok(recheckUploadResourcePolicy(pin, policy()));
});

test("accessors and inherited policy fail without getter execution", () => {
  let reads = 0;
  for (const key of Object.keys(policy())) {
    const p = Object.defineProperty(policy(), key, { get() { reads++; return 1; } });
    assert.equal(pinUploadResourcePolicy(p, identity()), null);
  }
  const p = policy();
  Object.defineProperty(p.identity, "namespace", { get() { reads++; return "/fixture/a"; } });
  assert.equal(pinUploadResourcePolicy(p, identity()), null);
  assert.equal(pinUploadResourcePolicy(Object.create(policy()), identity()), null);
  assert.equal(reads, 0);
});

test("invalid, overflowing, unbound and unsupported policies never produce a pin", () => {
  for (const bad of [null, [], {}, { ...policy(), maxFileBytes: Number.MAX_SAFE_INTEGER },
    { ...policy(), metadataBytes: "11" }, { ...policy(), adapter: "private-raw-writer" },
    { ...policy(), identity: { ...identity(), database: "other-cluster" } }]) {
    assert.equal(pinUploadResourcePolicy(bad, identity()), null);
  }
});

test("pin and returned snapshot are immutable, own their nested identity and are not reservations", () => {
  const p = policy(), original = structuredClone(p), pin = pinUploadResourcePolicy(p, identity())!;
  const result = recheckUploadResourcePolicy(pin, p)!;
  for (const value of [pin, result, result.policy, result.policy.identity, result.quote, result.quote.identity]) {
    assert.ok(Object.isFrozen(value));
  }
  p.identity.namespace = "changed";
  assert.deepEqual(result.policy.identity, identity());
  assert.equal(result.quote.kind, "upload-resource-quote-only");
  assert.deepEqual(recheckUploadResourcePolicy(pin, original), result);
  assert.notEqual(recheckUploadResourcePolicy(pin, original), result);
});
