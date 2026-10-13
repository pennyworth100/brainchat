import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inventoryUploadRoot } from "./resume-root-inventory";

const key = "a".repeat(64), second = "b".repeat(64);
const limits = { maxEntries: 10, maxMs: 1000, trustedStableAncestry: true };
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "dimle-root-inventory-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "root"); await fs.mkdir(root); return { base, root };
}
test("empty and exact-bound roots are observed, but blobs and cross-store state are not", async t => {
  const { root } = await fixture(t);
  const empty = await inventoryUploadRoot(root, limits);
  assert.equal(empty.enumerationComplete, true); assert.deepEqual(empty.entries, []);
  await fs.mkdir(join(root, key)); await fs.writeFile(join(root, key, "blob"), "untouched");
  const r = await inventoryUploadRoot(root, { ...limits, maxEntries: 1 });
  assert.equal(r.enumerationComplete, true); assert.deepEqual(r.entries, [{ storageKey: key, kind: "directory" }]);
  assert.equal(r.blobs, "unobserved"); assert.equal(r.crossStoreStability, "unproven");
  assert.equal(await fs.readFile(join(root, key, "blob"), "utf8"), "untouched");
});
test("one-over-bound is incomplete and bounded", async t => {
  const { root } = await fixture(t); await fs.mkdir(join(root, key)); await fs.mkdir(join(root, second));
  const r = await inventoryUploadRoot(root, { ...limits, maxEntries: 1 });
  assert.equal(r.entries.length, 1); assert.equal(r.enumerationComplete, false);
  assert.deepEqual(r.reasons, ["entry-limit"]);
});
test("unknown names are withheld and symlink targets are never traversed", async t => {
  const { base, root } = await fixture(t);
  await fs.mkdir(join(root, "private-name")); await fs.writeFile(join(base, "secret"), "secret");
  await fs.symlink(join(base, "secret"), join(root, key));
  const paths: string[] = [];
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    paths.push(String(args[0])); return fs.lstat(...args);
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, limits, io);
  assert.equal(r.enumerationComplete, false);
  assert.ok(r.entries.some(x => x.storageKey === key && x.kind === "symlink"));
  assert.ok(r.entries.some(x => x.storageKey === null));
  assert.ok(!JSON.stringify(r).includes("private-name"));
  assert.ok(paths.every(x => x === root || x === join(root, key) || x === join(root, "private-name")));
});
test("missing and symlink roots stay unobserved, not empty", async t => {
  const { base, root } = await fixture(t); const link = join(base, "link"); await fs.symlink(root, link);
  for (const path of [link, join(base, "missing")]) {
    const r = await inventoryUploadRoot(path, limits);
    assert.equal(r.enumerationComplete, false); assert.equal(r.rootStability, "unobserved");
    assert.deepEqual(r.reasons, ["io-unobserved"]);
  }
});
test("invalid contract and exhausted deadline perform no filesystem I/O", async () => {
  const io = { open: async () => { throw Error("should not open"); } } as unknown as typeof fs;
  for (const value of [0, -1, 10001, NaN, Infinity, 1.5]) {
    assert.deepEqual((await inventoryUploadRoot("/unused", { ...limits, maxEntries: value }, io)).reasons, ["invalid-contract"]);
  }
  assert.deepEqual((await inventoryUploadRoot("/unused", { ...limits, trustedStableAncestry: false }, io)).reasons, ["invalid-contract"]);
  let time = 0;
  assert.deepEqual((await inventoryUploadRoot("/unused", limits, io, () => time++ * 1000)).reasons, ["deadline"]);
});
test("entry I/O failure preserves positive key and cannot mean absent", async t => {
  const { root } = await fixture(t); await fs.mkdir(join(root, key));
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === join(root, key)) throw Error("injected permission failure");
    return fs.lstat(...args);
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, limits, io);
  assert.deepEqual(r.entries, [{ storageKey: key, kind: "unobserved" }]);
  assert.equal(r.enumerationComplete, false); assert.deepEqual(r.reasons, ["entry-unobserved"]);
});
test("root replacement during enumeration is unstable and both handles close", async t => {
  const { base, root } = await fixture(t); let closes = 0;
  const io = { ...fs, opendir: async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await fs.opendir(...args); const read = dir.read.bind(dir), close = dir.close.bind(dir);
    dir.read = (async () => { await fs.rename(root, join(base, "old")); await fs.mkdir(root); return read(); }) as typeof dir.read;
    dir.close = (async () => { closes++; await close(); }) as typeof dir.close; return dir;
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); const close = handle.close.bind(handle);
    handle.close = async () => { closes++; await close(); }; return handle;
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, limits, io);
  assert.equal(r.rootStability, "unstable"); assert.equal(r.enumerationComplete, false); assert.equal(closes, 2);
});
test("close failure prevents completion without leaking error text", async t => {
  const { root } = await fixture(t);
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args); const close = h.close.bind(h);
    h.close = async () => { await close(); throw Error("private injected detail"); }; return h;
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, limits, io);
  assert.equal(r.enumerationComplete, false); assert.deepEqual(r.reasons, ["close-unobserved"]);
});

test("newline-suffixed keys are unknown rather than canonical storage identities", async t => {
  const { root } = await fixture(t); await fs.mkdir(join(root, key + "\n"));
  const r = await inventoryUploadRoot(root, limits);
  assert.deepEqual(r.entries, [{ storageKey: null, kind: "directory" }]);
  assert.deepEqual(r.reasons, ["unknown-entry"]); assert.equal(r.enumerationComplete, false);
});
test("elapsed I/O deadline closes handles and retains no late entry", async t => {
  const { root } = await fixture(t); await fs.mkdir(join(root, key)); let now = 0, closes = 0;
  const io = { ...fs, opendir: async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await fs.opendir(...args); const read = dir.read.bind(dir), close = dir.close.bind(dir);
    dir.read = (async () => { const entry = await read(); now = 1000; return entry; }) as typeof dir.read;
    dir.close = (async () => { closes++; await close(); }) as typeof dir.close; return dir;
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, limits, io, () => now);
  assert.deepEqual(r.entries, []); assert.deepEqual(r.reasons, ["deadline"]);
  assert.equal(r.enumerationComplete, false); assert.equal(closes, 1);
});
test("limits are copied before awaiting and invalid initial clocks fail closed", async t => {
  const { root } = await fixture(t); await fs.mkdir(join(root, key)); await fs.mkdir(join(root, second));
  const mutable = { ...limits, maxEntries: 1 };
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    mutable.maxEntries = 10000; return fs.open(...args);
  } } as typeof fs;
  const r = await inventoryUploadRoot(root, mutable, io);
  assert.equal(r.entries.length, 1); assert.deepEqual(r.reasons, ["entry-limit"]);
  let calls = 0;
  assert.deepEqual((await inventoryUploadRoot(root, limits, fs, () => calls++ ? 0 : NaN)).reasons, ["deadline"]);
});
