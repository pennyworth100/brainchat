import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs, { mkdtemp, stat, rm, rename, mkdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindStrictUploadRoot, openStrictUploadRoot } from "./upload-storage-root";
import { pinStrictUploadResourcePolicy } from "./upload-resource-policy-pin";

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "dimle-root-pin-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, "root");
  await mkdir(path, { mode: 0o700 });
  const s = await stat(path, { bigint: true });
  const expected = { path, device: s.dev.toString(), inode: s.ino.toString(),
    uid: process.geteuid!(), gid: process.getegid!() };
  const identity = { database: "test-db", schema: "public", namespace: path,
    quotaDomain: "test-domain", policyVersion: "v1", writerGeneration: "g1" };
  // Synthetic arithmetic fixture, NEVER a production physical grant.
  const policy = { identity, adapter: "resume-strict-writer-v1",
    layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
    stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 10,
    allocationUnitBytes: 4096, allocationCopies: 1, directoryAndParentBytes: 4096,
    metadataBytes: 4096, temporaryBytes: 0, additionalObjects: 0 };
  const pin = pinStrictUploadResourcePolicy(policy, identity)!;
  assert.ok(pin);
  const binding = bindStrictUploadRoot(pin, policy, expected)!;
  assert.ok(binding);
  return { parent, path, expected, identity, policy, pin, binding };
}

test("exact root/policy binding returns only read-only directory; snapshots inputs", async t => {
  const f = await fixture(t);
  f.expected.path = "/not-the-root"; f.expected.inode = "1";
  f.policy.identity.quotaDomain = "mutated"; f.policy.maxFileBytes = 999;
  const h = await openStrictUploadRoot(f.binding, f.pin, 10);
  assert.ok((await h.stat()).isDirectory());
  await assert.rejects(h.write(Buffer.from("x")));
  await h.close();
  assert.deepEqual(await fs.readdir(f.path), []);
  assert.ok(Object.isFrozen(f.binding));
});

test("copied token/pin and wrong limit fail before even opening root", async t => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(fs, "open", async () => { calls++; throw Error("unexpected IO"); });
  for (const [binding, pin, limit] of [
    [{ ...f.binding }, f.pin, 10], [f.binding, { ...f.pin }, 10],
    [f.binding, f.pin, 9], [f.binding, f.pin, NaN],
  ] as const) await assert.rejects(openStrictUploadRoot(binding, pin, limit), /denied/);
  assert.equal(calls, 0);
});

test("same-value second policy pin is not interchangeable", async t => {
  const f = await fixture(t);
  const other = pinStrictUploadResourcePolicy(f.policy, f.identity)!;
  await assert.rejects(openStrictUploadRoot(f.binding, other, 10), /denied/);
});

test("expected root, namespace and startup identity mismatch fail binding", async t => {
  const f = await fixture(t);
  for (const changed of [
    { path: f.path + "/" }, { path: "/other" }, { inode: "01" }, { inode: "0" },
    { device: "-1" }, { uid: f.expected.uid + 1 }, { gid: f.expected.gid + 1 },
  ]) assert.equal(bindStrictUploadRoot(f.pin, f.policy, { ...f.expected, ...changed }), null);
  assert.equal(bindStrictUploadRoot({ ...f.pin }, f.policy, f.expected), null);
});

test("replaced directory with same owner/mode is rejected without mutation", async t => {
  const f = await fixture(t);
  await rename(f.path, join(f.parent, "old"));
  await mkdir(f.path, { mode: 0o700 });
  await assert.rejects(openStrictUploadRoot(f.binding, f.pin, 10), /denied/);
  assert.deepEqual(await fs.readdir(f.path), []);
});

test("root symlink and widened permissions are rejected", async t => {
  const f = await fixture(t);
  await chmod(f.path, 0o750);
  await assert.rejects(openStrictUploadRoot(f.binding, f.pin, 10), /denied/);
  await chmod(f.path, 0o700);
  await rename(f.path, join(f.parent, "old"));
  await symlink(join(f.parent, "old"), f.path);
  await assert.rejects(openStrictUploadRoot(f.binding, f.pin, 10));
});

test("effective identity drift fails before IO", async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(process as { geteuid: () => number }, "geteuid", () => f.expected.uid + 1);
  t.mock.method(fs, "open", async () => { calls++; throw Error("unexpected IO"); });
  await assert.rejects(openStrictUploadRoot(f.binding, f.pin, 10), /denied/);
  assert.equal(calls, 0);
});

test("failed fstat closes the opened descriptor", async t => {
  const f = await fixture(t); const original = fs.open; let closed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await original(...args), close = h.close.bind(h);
    t.mock.method(h, "stat", async () => { throw Error("fstat failed"); });
    t.mock.method(h, "close", async () => { closed = true; return close(); });
    return h;
  });
  await assert.rejects(openStrictUploadRoot(f.binding, f.pin, 10), /fstat failed/);
  assert.equal(closed, true);
});
