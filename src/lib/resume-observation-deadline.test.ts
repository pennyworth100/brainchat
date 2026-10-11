import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inventoryUploadRoot } from "./resume-root-inventory";
import { observeUploadBlob } from "./resume-blob-observation";

const key = "a".repeat(64);
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "dimle-observation-deadline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, key)); await fs.writeFile(join(root, key, "blob"), "abc");
  return root;
}
const limits = { maxEntries: 10, maxMs: 1000, trustedStableAncestry: true };
for (const kind of ["root", "metadata"] as const) {
  const observe = async (root: string, io: typeof fs, now: () => number) => {
    if (kind === "root") {
      const r = await inventoryUploadRoot(root, limits, io, now);
      return { complete: r.enumerationComplete, reasons: r.reasons, positive: r.entries.length };
    }
    const r = await observeUploadBlob(root, key, limits, io, now);
    return { complete: r.complete, reasons: r.reasons, positive: r.metadata?.sizeBytes };
  };
  test(kind + ": a clock regression above the initial time fails closed", async t => {
    const root = await fixture(t); let ticks = 0, closes = 0;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args), close = h.close.bind(h);
      h.close = async () => { closes++; await close(); }; return h;
    } } as typeof fs;
    const r = await observe(root, io, () => [0, 20, 10][ticks++] ?? 30);
    assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["deadline"]);
    assert.equal(closes, kind === "root" ? 1 : 0);
  });
  test(kind + ": completion includes cleanup deadline, invalid clock and regression", async t => {
    for (const finalTime of [1099, 1100, 1101, NaN, Infinity, 99]) {
      const root = await fixture(t); let now = 100;
      const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
        const h = await fs.open(...args), close = h.close.bind(h);
        h.close = async () => { await close(); now = finalTime; }; return h;
      } } as typeof fs;
      const r = await observe(root, io, () => now);
      assert.equal(r.complete, finalTime === 1099, String(finalTime));
      assert.deepEqual(r.reasons, finalTime === 1099 ? [] : ["deadline"]);
      assert.equal(r.positive, kind === "root" ? 1 : "3");
    }
  });
  test(kind + ": pending close is awaited, then late completion is withheld", async t => {
    const root = await fixture(t); let now = 0, settled = false;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closing = new Promise<void>(resolve => { entered = resolve; });
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args), close = h.close.bind(h);
      h.close = async () => { entered(); await gate; await close(); }; return h;
    } } as typeof fs;
    const pending = observe(root, io, () => now).then(r => { settled = true; return r; });
    await closing; now = 1000; await Promise.resolve(); assert.equal(settled, false);
    release(); const r = await pending;
    assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["deadline"]);
    assert.equal(r.positive, kind === "root" ? 1 : "3");
  });
  test(kind + ": synchronous close failure does not skip remaining handles", async t => {
    const root = await fixture(t); let closes = 0;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args), close = h.close.bind(h);
      if (String(args[0]) === root) {
        t.after(close); // Injected close failure cannot close this real fixture FD.
        h.close = () => { closes++; throw Error("private synchronous close detail"); };
      } else h.close = async () => { closes++; await close(); };
      return h;
    } } as typeof fs;
    const r = await observe(root, io, () => 0);
    assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["close-unobserved"]);
    assert.equal(closes, kind === "root" ? 1 : 3);
  });
}

