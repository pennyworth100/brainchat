import assert from "node:assert/strict";
import test from "node:test";
import { evaluateUploadResourceDomain, evaluateStrictUploadResourceDomain } from "./upload-resource-domain";
import { pinUploadResourcePolicy as pinMulter, pinStrictUploadResourcePolicy as pinStrict } from "./upload-resource-policy-pin";

for (const [adapter, evaluate, pinUploadResourcePolicy] of [
  ["multer-crossing-byte-v1", evaluateUploadResourceDomain, pinMulter],
  ["resume-strict-writer-v1", evaluateStrictUploadResourceDomain, pinStrict],
] as const) {

const identity = () => ({ database: '["owned-cluster","postgres"]', schema: "public",
  namespace: "a", quotaDomain: "shared-volume", policyVersion: "v1", writerGeneration: "g1" });
const policy = () => ({ identity: identity(), adapter,
  layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
  stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
  allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10,
  metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 }); // 41 bytes, 5 objects
const domain = (): Record<string, unknown> => ({
  database_identity: identity().database, schema_identity: "public", quota_domain: "shared-volume",
  writer_generation: "g1", active: true, audit_id: "cut-1",
  capacity_bytes: "100", headroom_bytes: "10", baseline_bytes: "9", outstanding_bytes: "40",
  capacity_objects: "20", headroom_objects: "2", baseline_objects: "3", outstanding_objects: "10",
});
function fixture() {
  const p = policy(), d = domain(), pin = pinUploadResourcePolicy(p, identity())!;
  return { p, d, pin, run: () => evaluate(pin, p, d, "cut-1") };
}

test("inclusive two-dimensional envelope recomputes quote and preserves prior liabilities", () => {
  const f = fixture(), before = structuredClone(f.d);
  Object.assign(f.p, { allocatedBytes: 0, objects: 0 });
  const result = f.run()!;
  assert.equal(result.quote.allocatedBytes, 41);
  assert.equal(result.quote.objects, 5);
  assert.equal(result.outstandingBytesAfter, "81");
  assert.equal(result.outstandingObjectsAfter, "15");
  assert.equal(result.auditId, "cut-1");
  assert.deepEqual(f.d, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.quote));
  assert.equal(result.kind, "upload-resource-domain-evaluation-only");
});

for (const dimension of ["bytes", "objects"]) {
  test(dimension + " exhaustion denies even when the other dimension fits", () => {
    const f = fixture();
    f.d["capacity_" + dimension] = dimension === "bytes" ? "99" : "19";
    const before = structuredClone(f.d);
    assert.equal(f.run(), null);
    assert.deepEqual(f.d, before);
  });
  test(dimension + " invalid balances, overcommitted envelope and zero capacity deny", () => {
    for (const patch of [
      { ["capacity_" + dimension]: "0" },
      { ["headroom_" + dimension]: "9007199254740991" },
      { ["baseline_" + dimension]: "9007199254740991" },
      { ["outstanding_" + dimension]: "9007199254740991" },
    ]) {
      const f = fixture(); Object.assign(f.d, patch); assert.equal(f.run(), null);
    }
  });
}

test("every PostgreSQL numeric field rejects missing, coercible and unsafe encodings", () => {
  for (const dimension of ["bytes", "objects"]) {
    for (const prefix of ["capacity", "headroom", "baseline", "outstanding"]) {
      const key = prefix + "_" + dimension;
      for (const bad of [undefined, null, 0, 1n, -1, NaN, "01", "-0", "-1", "+1", "1.0",
        "1e2", " 1", "1 ", "", "9007199254740992", "9".repeat(10000)]) {
        const f = fixture(); f.d[key] = bad; assert.equal(f.run(), null, key + ":" + String(bad).slice(0, 30));
      }
      const f = fixture(); delete f.d[key]; assert.equal(f.run(), null, key);
    }
  }
});

test("safe-integer boundary is exact and one extra outstanding unit denies", () => {
  const f = fixture();
  f.d.capacity_bytes = "9007199254740991";
  f.d.headroom_bytes = "0"; f.d.baseline_bytes = "0";
  f.d.outstanding_bytes = "9007199254740950";
  assert.equal(f.run()!.outstandingBytesAfter, "9007199254740991");
  f.d.outstanding_bytes = "9007199254740951";
  assert.equal(f.run(), null);
});

test("domain identity, generation, enabled state and audit must match exactly", () => {
  for (const key of ["database_identity", "schema_identity", "quota_domain", "writer_generation", "active", "audit_id"]) {
    for (const bad of [undefined, null, false, 1, "true", "other"]) {
      const f = fixture(); f.d[key] = bad; assert.equal(f.run(), null, key);
    }
  }
  const f = fixture();
  for (const bad of [null, undefined, "", " cut-1", "cut-1 ", "cut-1\n", "x".repeat(513), "other"]) {
    assert.equal(evaluate(f.pin, f.p, f.d, bad), null);
  }
});

test("locked policy recheck rejects all identity changes and same-charge policy swaps", () => {
  for (const key of Object.keys(identity())) {
    const f = fixture();
    Object.assign(f.p.identity, { [key]: "changed" });
    assert.equal(f.run(), null, key);
  }
  const f = fixture();
  f.p.metadataBytes++; f.p.temporaryBytes--;
  assert.equal(f.run(), null);
});

test("foreign/copy pins and missing or non-data rows never pass", () => {
  const f = fixture();
  for (const bad of [{}, { ...f.pin }, null, "pin"]) assert.equal(evaluate(bad, f.p, f.d, "cut-1"), null);
  for (const bad of [null, [], Object.create(f.d), new Date(), {}]) {
    assert.equal(evaluate(f.pin, f.p, bad, "cut-1"), null);
  }
});

test("all required domain fields reject accessors without executing getters", () => {
  let reads = 0;
  for (const key of Object.keys(domain())) {
    const f = fixture();
    Object.defineProperty(f.d, key, { get() { reads++; return domain()[key]; } });
    assert.equal(f.run(), null, key);
  }
  assert.equal(reads, 0);
});

test("generation rollover never clears existing domain liabilities", () => {
  const f = fixture();
  f.d.writer_generation = "g2";
  assert.equal(f.run(), null);
  f.p.identity.writerGeneration = "g2"; f.p.identity.policyVersion = "v2";
  const newPin = pinUploadResourcePolicy(f.p, f.p.identity)!;
  const result = evaluate(newPin, f.p, f.d, "cut-1")!;
  assert.equal(result.outstandingBytesAfter, "81");
  assert.equal(result.outstandingObjectsAfter, "15");
});

test("two namespaces evaluate against the same charged domain, not independent capacity", () => {
  const f = fixture(), first = f.run()!;
  f.d.outstanding_bytes = first.outstandingBytesAfter;
  f.d.outstanding_objects = first.outstandingObjectsAfter;
  f.p.identity.namespace = "b";
  const pinB = pinUploadResourcePolicy(f.p, f.p.identity)!;
  assert.equal(evaluate(pinB, f.p, f.d, "cut-1"), null);
});

test("result owns its snapshot, while repeated evaluation neither charges nor grants", () => {
  const f = fixture(), first = f.run()!, second = f.run()!;
  assert.deepEqual(first, second); assert.notEqual(first, second);
  f.d.outstanding_bytes = "0"; f.p.identity.namespace = "changed";
  assert.equal(first.outstandingBytesAfter, "81");
  assert.equal(first.quote.identity.namespace, "a");
  assert.equal(first.quote.kind, "upload-resource-quote-only");
});

test(adapter + ": exact allocation boundary preserves L versus L+1", () => {
  const p = policy(), d = domain(); p.maxFileBytes = 4;
  const pin = pinUploadResourcePolicy(p, p.identity)!;
  d.capacity_bytes = "96"; // 10 headroom + 9 baseline + 40 outstanding + 37 strict cost
  const result = evaluate(pin, p, d, "cut-1");
  if (adapter === "resume-strict-writer-v1") {
    assert.equal(result!.quote.allocatedBytes, 37);
    assert.equal(result!.outstandingBytesAfter, "77");
    d.capacity_bytes = "95"; assert.equal(evaluate(pin, p, d, "cut-1"), null);
  } else assert.equal(result, null); // Multer crossing byte requires the next allocation unit
});

test(adapter + ": cross-adapter pins and policy substitutions deny even with equal cost", () => {
  const f = fixture(); // L=6: both adapters round to 8 file bytes
  const other = adapter === "resume-strict-writer-v1"
    ? evaluateUploadResourceDomain : evaluateStrictUploadResourceDomain;
  assert.equal(other(f.pin, f.p, f.d, "cut-1"), null);
  const swapped = { ...f.p, adapter: adapter === "resume-strict-writer-v1"
    ? "multer-crossing-byte-v1" : "resume-strict-writer-v1" };
  assert.equal(evaluate(f.pin, swapped, f.d, "cut-1"), null);
  assert.equal(other(f.pin, swapped, f.d, "cut-1"), null);
});
}
