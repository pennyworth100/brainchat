/** Real IndexedDB journal boundaries; no server or managed recovery claim. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
const bundle = await build({ entryPoints: ["src/lib/browser-lease-journal.ts"], bundle: true,
  write: false, format: "iife", globalName: "leaseAPI", platform: "browser" });
const composed = await build({ entryPoints: ["src/lib/browser-durable-resume.ts"], bundle: true,
  write: false, format: "iife", globalName: "durableAPI", platform: "browser" });
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Lease fixture</title>"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {});
const checks = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const inject = async p => { await p.goto(origin); await p.addScriptTag({ content: bundle.outputFiles[0].text }); };
  await inject(page);
  const first = await page.evaluate(async () => {
    const op = crypto.randomUUID();
    const pending = await leaseAPI.browserLeaseJournal("owner", { expectedRevision: null,
      change: { kind: "join", roomId: "proof123", username: "Owner", operationId: op } });
    const lease = { roomId: "proof123", username: "Owner", sessionId: crypto.randomUUID(),
      token: "A".repeat(43), generation: 1, expiresAt: Date.now() + 600000 };
    const accepted = await leaseAPI.browserLeaseJournal("owner", { expectedRevision: pending.revision,
      change: { kind: "accept", lease } });
    return accepted;
  });
  await inject(page);
  assert.deepEqual(await page.evaluate(() => leaseAPI.browserLeaseJournal("owner")), first);
  checks.push("exact original lease survives actual page reload");
  assert.equal(await page.evaluate(() => leaseAPI.browserLeaseJournal("other-owner")), undefined);
  checks.push("different local scope cannot accidentally load original record");
  const tab = await context.newPage(); await inject(tab);
  const race = p => p.evaluate(async expectedRevision => {
    try { return { ok: true, row: await leaseAPI.browserLeaseJournal("owner",
      { expectedRevision, change: { kind: "resume", operationId: crypto.randomUUID() } }) }; }
    catch { return { ok: false }; }
  }, first.revision);
  const results = await Promise.all([race(page), race(tab)]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const pending = results.find(r => r.ok).row;
  checks.push("two physical pages race exact revision: exactly one CAS commits");
  await inject(page);
  assert.deepEqual(await page.evaluate(() => leaseAPI.browserLeaseJournal("owner")), pending);
  const replay = await page.evaluate(async revision => {
    try { await leaseAPI.browserLeaseJournal("owner", { expectedRevision: revision,
      change: { kind: "resume", operationId: crypto.randomUUID() } }); return false; } catch { return true; }
  }, pending.revision);
  assert.equal(replay, true);
  checks.push("reload after durable resume intent preserves CAS and refuses automatic retry");
  const transferred = await page.evaluate(async revision => leaseAPI.browserLeaseJournal("owner",
    { expectedRevision: revision, change: { kind: "transfer", operationId: crypto.randomUUID() } }), pending.revision);
  assert.equal(transferred.attempt.originalOperationId, pending.attempt.operationId);
  await inject(page);
  const denied = await page.evaluate(async revision => {
    try { await leaseAPI.browserLeaseJournal("owner", { expectedRevision: revision,
      change: { kind: "transfer", operationId: crypto.randomUUID() } }); return false; } catch { return true; }
  }, transferred.revision);
  assert.equal(denied, true);
  assert.deepEqual(await page.evaluate(() => leaseAPI.browserLeaseJournal("owner")), transferred);
  checks.push("lost transfer ACK retains consumed original provenance without transfer chaining");
  const aborted = await page.evaluate(async () => {
    const native = IDBObjectStore.prototype.put;
    let effects = 0, strict = false;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args) {
      if (args[1] === "readwrite") strict = args[2]?.durability === "strict";
      return transaction.apply(this, args);
    };
    IDBObjectStore.prototype.put = function(...args) {
      const request = native.apply(this, args); this.transaction.abort(); return request;
    };
    try {
      await leaseAPI.browserLeaseJournal("aborted", { expectedRevision: null,
        change: { kind: "join", roomId: "proof123", username: "Owner", operationId: crypto.randomUUID() } });
      effects++;
    } catch {} finally { IDBObjectStore.prototype.put = native; IDBDatabase.prototype.transaction = transaction; }
    return { effects, strict, row: await leaseAPI.browserLeaseJournal("aborted") };
  });
  assert.deepEqual(aborted, { effects: 0, strict: true, row: undefined });
  checks.push("actual transaction abort rejects before transport effect and leaves no record");
  const cloned = await page.evaluate(async () => {
    const input = { expectedRevision: null, change: { kind: "join", roomId: "proof123",
      username: "Owner", operationId: crypto.randomUUID() } };
    const saved = leaseAPI.browserLeaseJournal("cloned-input", input);
    input.change.username = "Tampered";
    return (await saved).username;
  });
  assert.equal(cloned, "Owner");
  checks.push("caller mutation during IndexedDB open cannot alter stored authority");
  const bounded = await page.evaluate(async () => {
    let admitted = 0, rejected = 0;
    for (let i = 0; i < 10; i++) {
      try { await leaseAPI.browserLeaseJournal("bounded-" + i, { expectedRevision: null,
        change: { kind: "join", roomId: "proof123", username: "Owner", operationId: crypto.randomUUID() } }); admitted++; }
      catch { rejected++; }
    }
    return { admitted, rejected, original: await leaseAPI.browserLeaseJournal("owner") };
  });
  assert.equal(bounded.admitted, 6); assert.equal(bounded.rejected, 4);
  assert.deepEqual(bounded.original, transferred);
  checks.push("eight-record global capacity refuses admission without evicting unresolved owner");
  const secondContext = await browser.newContext();
  const composedPage = await secondContext.newPage();
  const boot = async () => {
    await composedPage.goto(origin);
    await composedPage.addScriptTag({ content: bundle.outputFiles[0].text });
    await composedPage.addScriptTag({ content: composed.outputFiles[0].text });
  };
  await boot();
  const grant = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("composed"), p = {};
    const ticket = await c.beginJoin("proof123", "Owner", p);
    const grant = { roomId: "proof123", username: "Owner", sessionId: crypto.randomUUID(),
      token: "A".repeat(43), generation: 1, expiresAt: Date.now() + 600000 };
    await c.accept(ticket, p, grant);
    return grant;
  });
  await boot();
  const admitted = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("composed");
    const before = c.status();
    const admitted = await c.beginResume({});
    return { before, admitted, row: await leaseAPI.browserLeaseJournal("composed") };
  });
  assert.equal(admitted.before.phase, "offline");
  assert.deepEqual(admitted.admitted.lease, grant);
  assert.equal(admitted.row.attempt.operationId, admitted.admitted.ticket.operationId);
  checks.push("composed actual reload imports original credential OFFLINE and commits CAS before admission");
  await boot();
  const transfer = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("composed"), p = {};
    const admitted = await c.beginTransfer(p);
    const beforeAck = await leaseAPI.browserLeaseJournal("composed");
    await c.accept(admitted.ticket, p, { ...admitted.lease, generation: 3 });
    return { admitted, beforeAck, status: c.status(), saved: await leaseAPI.browserLeaseJournal("composed") };
  });
  assert.equal(transfer.admitted.ticket.originalOperationId, admitted.admitted.ticket.operationId);
  assert.equal(transfer.beforeAck.attempt.kind, "transfer");
  assert.equal(transfer.status.phase, "syncing");
  assert.equal(transfer.saved.lease.sessionId, grant.sessionId);
  assert.equal(transfer.saved.lease.generation, 3);
  checks.push("composed actual reload preserves original CAS transfer and grant commit does not enable READY");
  await boot();
  const lostJoin = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("lost-join");
    await c.beginJoin("proof123", "Owner", {});
    return leaseAPI.browserLeaseJournal("lost-join");
  });
  await boot();
  const lostJoinResult = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("lost-join");
    let effects = 0;
    try { await c.beginResume({}); effects++; } catch {}
    return { effects, row: await leaseAPI.browserLeaseJournal("lost-join") };
  });
  assert.equal(lostJoinResult.effects, 0); assert.deepEqual(lostJoinResult.row, lostJoin);
  checks.push("composed lost initial ACK reload retains tokenless intent without new admission");
  const abortedComposition = await composedPage.evaluate(async () => {
    const c = await durableAPI.createBrowserDurableResume("abort-composed");
    const native = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      const r = native.apply(this, args); this.transaction.abort(); return r;
    };
    let effects = 0;
    try { await c.beginJoin("proof123", "Owner", {}); effects++; }
    catch {} finally { IDBObjectStore.prototype.put = native; }
    return { effects, row: await leaseAPI.browserLeaseJournal("abort-composed"), status: c.status() };
  });
  assert.equal(abortedComposition.effects, 0); assert.equal(abortedComposition.row, undefined);
  assert.equal(abortedComposition.status.persistenceFailed, true);
  checks.push("composed actual IndexedDB abort prevents admission and fences in-memory controller");
  await secondContext.close();
  console.log(JSON.stringify({ result: "PASS", browser: browser.version(), checks }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
