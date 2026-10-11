import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeUploadContentBatch as observe, type ContentBatchContract } from "./resume-content-batch";

const a = "a".repeat(64), b = "b".repeat(64);
const limits: ContentBatchContract = { namespaceId: "isolated:fixture", trustedRootNamespaceBinding: true,
  trustedStableAncestry: true, maxKeys: 3, maxBytes: 6, maxReads: 2, maxMs: 1000,
  perKeyBytes: 3, perKeyReads: 1 };
async function fixture(t: TestContext, data = "abc") {
  const root = await fs.mkdtemp(join(tmpdir(), "dimle-content-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const key of [a, b]) { await fs.mkdir(join(root, key)); await fs.writeFile(join(root, key, "blob"), data); }
  return root;
}
test("batch retains duplicate observations with original indices, never a unique winner", async t => {
  const root = await fixture(t), r = await observe(root, [a, a], limits);
  assert.equal(r.allKeysAttempted, true); assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.observations.map(o => [o.storageKey, o.inputIndex, o.namespaceId, o.content.complete]),
    [[a, 0, limits.namespaceId, true], [a, 1, limits.namespaceId, true]]);
  assert.equal(r.reservedBytes, 6); assert.equal(r.reservedReads, 2);
  assert.equal(r.crossStoreStability, "unproven");
});
test("total bytes or read allowance stops next key BEFORE any of its I/O", async t => {
  const root = await fixture(t);
  for (const budget of [{ maxBytes: 5 }, { maxReads: 1 }]) {
    const paths: string[] = [];
    const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
      paths.push(String(args[0])); return fs.lstat(...args);
    } } as typeof fs;
    const r = await observe(root, [a, b], { ...limits, ...budget }, io);
    assert.deepEqual(r.reasons, ["total-budget"]); assert.equal(r.allKeysAttempted, false);
    assert.equal(r.observations.length, 1); assert.equal(r.reservedBytes, 3); assert.equal(r.reservedReads, 1);
    assert.ok(paths.every(p => !p.includes(b)));
  }
});
test("failed reads consume full reservation; no retry, refund, or missing-file absence", async t => {
  const root = await fixture(t); let reads = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args);
    if (String(args[0]).endsWith("/blob")) h.read = async () => { reads++; throw Error("private-path"); };
    return h;
  } } as typeof fs;
  const r = await observe(root, [a, b], { ...limits, maxReads: 1 }, io);
  assert.equal(reads, 1); assert.equal(r.reservedReads, 1); assert.equal(r.reservedBytes, 3);
  assert.deepEqual(r.observations[0].content.reasons, ["io-unobserved"]);
  assert.equal(r.observations[0].content.sha256, null); assert.deepEqual(r.reasons, ["total-budget"]);
});
test("attempted-all is not success: preserves independent failed and successful observations", async t => {
  const root = await fixture(t); await fs.unlink(join(root, a, "blob"));
  const r = await observe(root, [a, b], limits);
  assert.equal(r.allKeysAttempted, true); assert.equal(r.observations[0].content.complete, false);
  assert.equal(r.observations[1].content.complete, true); assert.equal(r.reservedBytes, 6);
});
test("zero-byte batch can observe empty files, still reserves operations", async t => {
  const root = await fixture(t, "");
  const r = await observe(root, [a, b], { ...limits, maxBytes: 0, perKeyBytes: 0 });
  assert.equal(r.allKeysAttempted, true); assert.equal(r.reservedBytes, 0); assert.equal(r.reservedReads, 2);
  assert.ok(r.observations.every(o => o.content.complete && o.content.bytesRead === 0));
});
test("invalid trust, provenance, bounds, sparse keys and late bad key reject all I/O", async () => {
  let calls = 0;
  const io = { lstat: async () => { calls++; throw Error("no I/O"); } } as unknown as typeof fs;
  const bad: Partial<ContentBatchContract>[] = [
    { trustedStableAncestry: false }, { trustedRootNamespaceBinding: false },
    { namespaceId: "bad\n" }, { namespaceId: "" }, { namespaceId: "a".repeat(129) },
    { maxKeys: 1001 }, { maxKeys: 0 }, { maxBytes: 67108865 }, { maxReads: 4097 },
    { maxMs: 0 }, { maxMs: 30001 }, { perKeyBytes: -1 }, { perKeyReads: 0 },
  ];
  for (const field of ["maxKeys", "maxBytes", "maxReads", "maxMs", "perKeyBytes", "perKeyReads"]) {
    for (const value of [NaN, Infinity, -1, 1.5]) bad.push({ [field]: value });
  }
  for (const contract of bad) assert.deepEqual((await observe("/unused", [a], { ...limits, ...contract }, io)).reasons, ["invalid-contract"]);
  for (const keys of [[a, b + "\n"], [a, "../" + b], [a, b.toUpperCase()], new Array<string>(2)])
    assert.deepEqual((await observe("/unused", keys, limits, io)).reasons, ["invalid-contract"]);
  assert.deepEqual((await observe("relative", [a], limits, io)).reasons, ["invalid-contract"]);
  assert.equal(calls, 0);
});
test("bounded empty input makes no I/O and conveys no namespace completeness", async () => {
  const r = await observe("/unused", [], { ...limits, maxKeys: 0, maxBytes: 0, maxReads: 0 });
  assert.equal(r.allKeysAttempted, true); assert.deepEqual(r.observations, []);
});
test("keys, namespace and total/per-file contracts are copied before first await", async t => {
  const root = await fixture(t), keys = [a, b], mutable = { ...limits, maxBytes: 3 };
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    keys[1] = a; mutable.namespaceId = "changed"; mutable.maxBytes = 6; mutable.perKeyBytes = 0;
    return fs.lstat(...args);
  } } as typeof fs;
  const r = await observe(root, keys, mutable, io);
  assert.equal(r.observations.length, 1); assert.equal(r.observations[0].namespaceId, limits.namespaceId);
  assert.equal(r.reservedBytes, 3); assert.deepEqual(r.reasons, ["total-budget"]);
});
test("key mutation cannot redirect the second observation", async t => {
  const root = await fixture(t), keys = [a, b];
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    keys[1] = a; return fs.lstat(...args);
  } } as typeof fs;
  const r = await observe(root, keys, limits, io);
  assert.deepEqual(r.observations.map(o => o.storageKey), [a, b]);
});
test("one global deadline fences delayed child admission and retains late partial evidence", async t => {
  const root = await fixture(t); let time = 0, reads = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args);
    if (String(args[0]).endsWith("/blob")) {
      const read = h.read.bind(h);
      h.read = (async (...args: Parameters<typeof read>) => {
        reads++; const r = await read(...args); time = limits.maxMs; return r;
      }) as typeof h.read;
    }
    return h;
  } } as typeof fs;
  const r = await observe(root, [a, b], limits, io, () => time);
  assert.equal(reads, 1); assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].content.bytesRead, 3); assert.equal(r.observations[0].content.sha256, null);
  assert.deepEqual(r.reasons, ["deadline"]); assert.equal(r.allKeysAttempted, false);
});
test("nonfinite/regressing clocks and time exhausted before child I/O fail closed", async () => {
  let calls = 0;
  const io = { lstat: async () => { calls++; throw Error("no I/O"); } } as unknown as typeof fs;
  for (const times of [[NaN], [Infinity], [0, 10, 5, 20], [0, 0, 1000]]) {
    let n = 0;
    const r = await observe("/unused", [a, b], limits, io, () => times[Math.min(n++, times.length - 1)]);
    assert.deepEqual(r.reasons, ["deadline"]); assert.equal(r.allKeysAttempted, false);
  }
  assert.equal(calls, 0);
});
test("pending close settles before next key opens; deadline stops next admission", async t => {
  const root = await fixture(t); let time = 0, settled = false, nextOpened = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), waiting = new Promise<void>(r => { entered = r; });
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes(b)) nextOpened = true;
    const h = await fs.open(...args), close = h.close.bind(h);
    if (String(args[0]) === join(root, a, "blob")) h.close = async () => { entered(); await gate; await close(); };
    return h;
  } } as typeof fs;
  const pending = observe(root, [a, b], limits, io, () => time).then(r => { settled = true; return r; });
  await waiting; time = 1000; await new Promise(r => setImmediate(r));
  assert.equal(settled, false); assert.equal(nextOpened, false);
  release(); const r = await pending;
  assert.equal(nextOpened, false); assert.equal(r.observations[0].content.sha256, null);
  assert.deepEqual(r.reasons, ["deadline"]);
});
