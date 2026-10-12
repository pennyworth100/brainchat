import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeUploadBlob } from "./resume-blob-observation";

const key = "a".repeat(64), limits = { maxMs: 1000, trustedStableAncestry: true };
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(join(tmpdir(), "dimle-blob-observation-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "root"), dir = join(root, key), blob = join(dir, "blob");
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(blob, "hello");
  return { base, root, dir, blob };
}
test("metadata-only fixed-depth observation retains no content or integrity verdict", async t => {
  const { root } = await fixture(t); const paths: string[] = []; let closes = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    paths.push(String(args[0])); const h = await fs.open(...args), close = h.close.bind(h);
    h.read = async () => { throw Error("content must not be read"); };
    h.readFile = async () => { throw Error("content must not be read"); };
    h.close = async () => { closes++; await close(); }; return h;
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.deepEqual(r, { metadata: { sizeBytes: "5", linkCount: "1" }, stability: "unchanged-at-checks",
    complete: true, reasons: [], content: "unobserved", crossStoreStability: "unproven" });
  assert.deepEqual(paths, [root, join(root, key), join(root, key, "blob")]); assert.equal(closes, 3);
});
test("empty regular file has observed zero size, unlike missing or unreadable", async t => {
  const { root, blob } = await fixture(t); await fs.truncate(blob);
  assert.equal((await observeUploadBlob(root, key, limits)).metadata?.sizeBytes, "0");
  await fs.unlink(blob); const r = await observeUploadBlob(root, key, limits);
  assert.equal(r.metadata, null); assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["io-unobserved"]);
});
test("symlinks at root, keyed directory and blob never open their targets", async t => {
  for (const level of ["root", "dir", "blob"] as const) {
    const f = await fixture(t), target = join(f.base, "target");
    await fs.rename(f[level], target); await fs.symlink(target, f[level]);
    const opened: string[] = [];
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      opened.push(String(args[0])); return fs.open(...args);
    } } as typeof fs;
    const r = await observeUploadBlob(f.root, key, limits, io);
    assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["unsupported-type"]);
    assert.ok(!opened.includes(f[level]));
  }
});
test("FIFO and directory blobs are rejected before open", async t => {
  for (const kind of ["fifo", "directory"]) {
    const { root, blob } = await fixture(t); await fs.unlink(blob);
    if (kind === "fifo") execFileSync("mkfifo", [blob]); else await fs.mkdir(blob);
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      assert.notEqual(String(args[0]), blob); return fs.open(...args);
    } } as typeof fs;
    assert.deepEqual((await observeUploadBlob(root, key, limits, io)).reasons, ["unsupported-type"]);
  }
});
test("FIFO replacement at open uses NONBLOCK and fails fstat without hanging", async t => {
  const { root, blob } = await fixture(t); let closed = false;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === blob) {
      assert.ok(Number(args[1]) & constants.O_NONBLOCK); assert.ok(Number(args[1]) & constants.O_NOFOLLOW);
      await fs.unlink(blob); execFileSync("mkfifo", [blob]);
    }
    const h = await fs.open(...args), close = h.close.bind(h);
    h.close = async () => { if (String(args[0]) === blob) closed = true; await close(); }; return h;
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.equal(r.stability, "unstable"); assert.equal(r.complete, false); assert.equal(closed, true);
});
test("hardlinked blob is not accepted as an isolated storage object", async t => {
  const { base, root, blob } = await fixture(t); await fs.link(blob, join(base, "alias"));
  const r = await observeUploadBlob(root, key, limits);
  assert.equal(r.metadata, null); assert.deepEqual(r.reasons, ["unsupported-metadata"]);
});
test("same-size path replacement after open is unstable while retaining positive size", async t => {
  const { root, blob } = await fixture(t); let reads = 0;
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === blob && ++reads === 2) {
      await fs.rename(blob, blob + ".old"); await fs.writeFile(blob, "world");
    }
    return fs.lstat(...args);
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.equal(r.metadata?.sizeBytes, "5"); assert.equal(r.stability, "unstable"); assert.equal(r.complete, false);
});
test("in-place changes between fstats are detected", async t => {
  const { root, blob } = await fixture(t);
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args);
    if (String(args[0]) === blob) {
      const stat = h.stat.bind(h); let calls = 0;
      h.stat = (async (...a: Parameters<typeof h.stat>) => {
        if (++calls === 2) await fs.appendFile(blob, "changed"); return stat(...a);
      }) as typeof h.stat;
    }
    return h;
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.equal(r.stability, "unstable"); assert.equal(r.complete, false);
});
test("keyed-directory replacement is detected even when blob inode is preserved", async t => {
  const { root, dir, blob } = await fixture(t); let reads = 0;
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === dir && ++reads === 2) {
      await fs.rename(dir, dir + ".old"); await fs.mkdir(dir);
      await fs.rename(join(dir + ".old", "blob"), blob);
    }
    return fs.lstat(...args);
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.equal(r.stability, "unstable"); assert.equal(r.complete, false);
});
test("disappearance and permission failure are unobserved, never absent or empty", async t => {
  for (const kind of ["disappear", "permission"]) {
    const { root, blob } = await fixture(t);
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === blob) {
        if (kind === "disappear") await fs.unlink(blob); else throw Error("private EACCES detail");
      }
      return fs.open(...args);
    } } as typeof fs;
    const r = await observeUploadBlob(root, key, limits, io);
    assert.equal(r.metadata, null); assert.deepEqual(r.reasons, ["io-unobserved"]); assert.equal(r.complete, false);
  }
});
test("invalid keys, limits and trust fail before I/O", async () => {
  let calls = 0;
  const io = { lstat: async () => { calls++; throw Error("must not stat"); } } as unknown as typeof fs;
  for (const k of [key + "\n", "../" + key, key.toUpperCase(), "", key.slice(1)]) {
    assert.deepEqual((await observeUploadBlob("/unused", k, limits, io)).reasons, ["invalid-contract"]);
  }
  for (const maxMs of [0, -1, 30001, Infinity, NaN, 1.5]) {
    assert.deepEqual((await observeUploadBlob("/unused", key, { ...limits, maxMs }, io)).reasons, ["invalid-contract"]);
  }
  assert.deepEqual((await observeUploadBlob("/unused", key, { ...limits, trustedStableAncestry: false }, io)).reasons, ["invalid-contract"]);
  assert.deepEqual((await observeUploadBlob("relative", key, limits, io)).reasons, ["invalid-contract"]);
  assert.equal(calls, 0);
});
test("deadline after opening closes all handles; copied budget cannot be extended", async t => {
  const { root, blob } = await fixture(t); let time = 0, closes = 0;
  const mutable = { ...limits };
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args), close = h.close.bind(h);
    h.close = async () => { closes++; await close(); };
    if (String(args[0]) === blob) { time = 1000; mutable.maxMs = 30000; }
    return h;
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, mutable, io, () => time);
  assert.deepEqual(r.reasons, ["deadline"]); assert.equal(closes, 3); assert.equal(r.complete, false);
  for (const clock of [NaN, Infinity]) {
    assert.deepEqual((await observeUploadBlob(root, key, limits, fs, () => clock)).reasons, ["deadline"]);
  }
});
test("one close failure still closes every handle and prevents completion", async t => {
  const { root } = await fixture(t); let closes = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args), close = h.close.bind(h);
    h.close = async () => { closes++; await close(); if (String(args[0]) === root) throw Error("secret detail"); }; return h;
  } } as typeof fs;
  const r = await observeUploadBlob(root, key, limits, io);
  assert.equal(closes, 3); assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["close-unobserved"]);
});
