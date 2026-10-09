import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeUploadBlobContent as observe } from "./resume-blob-content-observation";

const key = "a".repeat(64);
const limits = { maxBytes: 200000, maxReads: 4096, maxMs: 1000, trustedStableAncestry: true };
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
async function fixture(t: TestContext, data: string | Buffer = "hello") {
  const base = await fs.mkdtemp(join(tmpdir(), "dimle-blob-content-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "root"), dir = join(root, key), blob = join(dir, "blob");
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(blob, data);
  return { base, root, dir, blob };
}
function instrument(blob: string, hook: (h: FileHandle) => void) {
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args); if (String(args[0]) === blob) hook(h); return h;
  } } as typeof fs;
}
test("content exact cap uses one reusable 64KiB buffer and explicit offsets, no EOF overread", async t => {
  const data = Buffer.alloc(150000, 37), f = await fixture(t, data);
  const requests: number[] = [], buffers = new Set<Buffer>(); let position = 0;
  const io = instrument(f.blob, h => {
    const read = h.read.bind(h);
    h.read = (async (buffer: Buffer, offset: number, length: number, pos: number) => {
      assert.equal(pos, position); assert.equal(offset, 0); assert.ok(length <= 65536);
      assert.ok(pos + length <= data.length); buffers.add(buffer); requests.push(length);
      const r = await read(buffer, offset, length, pos); position += r.bytesRead; return r;
    }) as typeof h.read;
    h.readFile = async () => { throw Error("unbounded read forbidden"); };
  });
  const r = await observe(f.root, key, { ...limits, maxBytes: data.length }, io);
  assert.equal(r.complete, true); assert.equal(r.sha256, digest(data)); assert.equal(r.bytesRead, data.length);
  assert.equal(r.crossStoreStability, "unproven"); assert.equal(buffers.size, 1);
  assert.deepEqual(requests, [65536, 65536, 18928]);
});
test("zero cap hashes an empty regular file without content I/O", async t => {
  const f = await fixture(t, "");
  const io = instrument(f.blob, h => { h.read = async () => { throw Error("must not read"); }; });
  const r = await observe(f.root, key, { ...limits, maxBytes: 0 }, io);
  assert.equal(r.complete, true); assert.equal(r.bytesRead, 0); assert.equal(r.sha256, digest(""));
});
test("oversize fails before any content read, retaining exact positive stat size", async t => {
  const f = await fixture(t); let reads = 0;
  const io = instrument(f.blob, h => { h.read = async () => { reads++; throw Error("must not read"); }; });
  const r = await observe(f.root, key, { ...limits, maxBytes: 4 }, io);
  assert.equal(reads, 0); assert.equal(r.metadata?.sizeBytes, "5");
  assert.deepEqual(r.reasons, ["byte-limit"]); assert.equal(r.sha256, null); assert.equal(r.complete, false);
});
test("short positive reads advance offsets; operation cap stops pathological progress", async t => {
  const f = await fixture(t); let reads = 0;
  const io = instrument(f.blob, h => { const read = h.read.bind(h);
    h.read = (async (buffer: Buffer, offset: number, _length: number, pos: number) => {
      reads++; return read(buffer, offset, 1, pos);
    }) as typeof h.read;
  });
  assert.equal((await observe(f.root, key, limits, io)).sha256, digest("hello"));
  reads = 0; const r = await observe(f.root, key, { ...limits, maxReads: 2 }, io);
  assert.equal(reads, 2); assert.equal(r.bytesRead, 2); assert.equal(r.sha256, null);
  assert.deepEqual(r.reasons, ["read-limit"]);
});
test("early EOF and impossible read counts never publish digest", async t => {
  for (const count of [0, -1, 6, NaN, 1.5]) {
    const f = await fixture(t);
    const io = instrument(f.blob, h => {
      h.read = (async () => ({ bytesRead: count })) as typeof h.read;
    });
    const r = await observe(f.root, key, limits, io);
    assert.equal(r.complete, false); assert.equal(r.sha256, null);
    assert.deepEqual(r.reasons, [count === 0 ? "early-eof" : "invalid-read"]);
  }
});
test("content mutation, growth and path replacement after read invalidate digest", async t => {
  for (const mutation of ["inplace", "grow", "replace", "key"]) {
    const f = await fixture(t);
    const io = instrument(f.blob, h => { const read = h.read.bind(h);
      h.read = (async (...args: Parameters<typeof read>) => {
        const r = await read(...args);
        if (mutation === "grow") await fs.appendFile(f.blob, "!");
        if (mutation === "inplace") { await fs.writeFile(f.blob, "world"); await fs.utimes(f.blob, 1, 1); }
        if (mutation === "replace") { await fs.rename(f.blob, f.blob + ".old"); await fs.writeFile(f.blob, "world"); }
        if (mutation === "key") { await fs.rename(f.dir, f.dir + ".old"); await fs.mkdir(f.dir); await fs.rename(join(f.dir + ".old", "blob"), f.blob); }
        return r;
      }) as typeof h.read;
    });
    const r = await observe(f.root, key, limits, io);
    assert.equal(r.bytesRead, 5); assert.equal(r.stability, "unstable"); assert.equal(r.sha256, null);
  }
});
test("symlinks at every depth, FIFO, directories and hardlinks cannot be hashed", async t => {
  for (const kind of ["root", "dir", "blob", "fifo", "directory", "hardlink"]) {
    const f = await fixture(t);
    if (kind === "root" || kind === "dir" || kind === "blob") {
      await fs.rename(f[kind], f[kind] + ".old"); await fs.symlink(f[kind] + ".old", f[kind]);
    } else if (kind === "hardlink") await fs.link(f.blob, join(f.base, "alias"));
    else { await fs.unlink(f.blob); if (kind === "fifo") execFileSync("mkfifo", [f.blob]); else await fs.mkdir(f.blob); }
    let reads = 0;
    const io = instrument(f.blob, h => { h.read = async () => { reads++; throw Error("must not read"); }; });
    const r = await observe(f.root, key, limits, io);
    assert.equal(reads, 0); assert.equal(r.complete, false); assert.equal(r.sha256, null);
  }
});
test("FIFO swapped at open is nonblocking, rejected by fstat and closed", async t => {
  const f = await fixture(t); let closed = false;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === f.blob) {
      assert.ok(Number(args[1]) & constants.O_NONBLOCK); assert.ok(Number(args[1]) & constants.O_NOFOLLOW);
      await fs.unlink(f.blob); execFileSync("mkfifo", [f.blob]);
    }
    const h = await fs.open(...args), close = h.close.bind(h);
    h.close = async () => { if (String(args[0]) === f.blob) closed = true; await close(); };
    return h;
  } } as typeof fs;
  const r = await observe(f.root, key, limits, io);
  assert.equal(closed, true); assert.equal(r.stability, "unstable"); assert.equal(r.sha256, null);
});
test("expired pending read settles and closes; mutable limits cannot extend budget", async t => {
  const f = await fixture(t); let time = 0, reads = 0, closed = false;
  const mutable = { ...limits };
  const io = instrument(f.blob, h => { const read = h.read.bind(h), close = h.close.bind(h);
    h.read = (async (...args: Parameters<typeof read>) => {
      reads++; const r = await read(...args); time = limits.maxMs;
      mutable.maxMs = 30000; mutable.maxBytes = 1; return r;
    }) as typeof h.read;
    h.close = async () => { closed = true; await close(); };
  });
  const r = await observe(f.root, key, mutable, io, () => time);
  assert.equal(reads, 1); assert.equal(closed, true); assert.equal(r.bytesRead, 5);
  assert.deepEqual(r.reasons, ["deadline"]); assert.equal(r.sha256, null);
});
test("byte and operation budgets are copied before awaits", async t => {
  const f = await fixture(t); const mutable = { ...limits, maxBytes: 4 };
  const io = { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    mutable.maxBytes = 200000; return fs.lstat(...args);
  } } as typeof fs;
  assert.deepEqual((await observe(f.root, key, mutable, io)).reasons, ["byte-limit"]);
  const small = { ...limits, maxReads: 1 };
  const partial = instrument(f.blob, h => { const read = h.read.bind(h);
    h.read = (async (b: Buffer, o: number, _l: number, p: number) => {
      small.maxReads = 4096; return read(b, o, 1, p);
    }) as typeof h.read;
  });
  assert.deepEqual((await observe(f.root, key, small, partial)).reasons, ["read-limit"]);
});
test("missing, permission/read errors remain unobserved without private error disclosure", async t => {
  for (const kind of ["missing", "permission", "read"]) {
    const f = await fixture(t);
    if (kind === "missing") await fs.unlink(f.blob);
    const io = kind === "permission" ? { ...fs, open: async () => { throw Error("private path"); } } as typeof fs
      : instrument(f.blob, h => { h.read = async () => { throw Error("private path"); }; });
    const r = await observe(f.root, key, limits, io);
    assert.deepEqual(r.reasons, ["io-unobserved"]); assert.equal(r.sha256, null); assert.equal(r.complete, false);
  }
});
test("every handle closes even if one close fails; no digest after cleanup failure", async t => {
  const f = await fixture(t); let closes = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args), close = h.close.bind(h);
    h.close = async () => { closes++; await close(); if (String(args[0]) === f.root) throw Error("private"); };
    return h;
  } } as typeof fs;
  const r = await observe(f.root, key, limits, io);
  assert.equal(closes, 3); assert.deepEqual(r.reasons, ["close-unobserved"]); assert.equal(r.sha256, null);
});
test("invalid content bounds, keys and trust fail before filesystem I/O", async () => {
  let calls = 0;
  const io = { lstat: async () => { calls++; throw Error("no I/O"); } } as unknown as typeof fs;
  for (const field of ["maxBytes", "maxReads", "maxMs"] as const) {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual((await observe("/unused", key, { ...limits, [field]: value }, io)).reasons, ["invalid-contract"]);
    }
  }
  for (const maxBytes of [67108865]) assert.deepEqual((await observe("/unused", key, { ...limits, maxBytes }, io)).reasons, ["invalid-contract"]);
  for (const maxReads of [0, 4097]) assert.deepEqual((await observe("/unused", key, { ...limits, maxReads }, io)).reasons, ["invalid-contract"]);
  for (const maxMs of [0, 30001]) assert.deepEqual((await observe("/unused", key, { ...limits, maxMs }, io)).reasons, ["invalid-contract"]);
  for (const k of [key + "\n", "../" + key, key.toUpperCase(), ""]) assert.deepEqual((await observe("/unused", k, limits, io)).reasons, ["invalid-contract"]);
  assert.deepEqual((await observe("relative", key, limits, io)).reasons, ["invalid-contract"]);
  assert.deepEqual((await observe("/unused", key, { ...limits, trustedStableAncestry: false }, io)).reasons, ["invalid-contract"]);
  assert.equal(calls, 0);
});
test("invalid and regressing clocks fail closed before further I/O", async t => {
  const f = await fixture(t);
  for (const value of [NaN, Infinity]) assert.deepEqual((await observe(f.root, key, limits, fs, () => value)).reasons, ["deadline"]);
  const times = [0, 10, 5]; let index = 0;
  assert.deepEqual((await observe(f.root, key, limits, fs, () => times[Math.min(index++, 2)])).reasons, ["deadline"]);
});

test("deadline during pending read or close cannot finish early or publish a late hash", async t => {
  for (const stage of ["read", "close"]) {
    const f = await fixture(t); let time = 0, settled = false;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const io = instrument(f.blob, h => {
      if (stage === "read") {
        const read = h.read.bind(h);
        h.read = (async (...args: Parameters<typeof read>) => {
          entered(); await blocked; return read(...args);
        }) as typeof h.read;
      } else {
        const close = h.close.bind(h);
        h.close = async () => { entered(); await blocked; await close(); };
      }
    });
    const pending = observe(f.root, key, limits, io, () => time).then(r => { settled = true; return r; });
    await waiting; time = limits.maxMs;
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release(); const r = await pending;
    assert.equal(r.complete, false); assert.equal(r.sha256, null); assert.deepEqual(r.reasons, ["deadline"]);
  }
});
