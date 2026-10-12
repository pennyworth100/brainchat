/** Built public React UI + controlled loopback Socket.IO/HTTP fixture.
 * This is NOT managed candidate/database acceptance or physical-device proof. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import next from "next";
import { Server } from "socket.io";
import { chromium, expect } from "@playwright/test";

const app = next({ dev: false, hostname: "127.0.0.1", dir: process.cwd() });
await app.prepare();
let uploads = 0, sends = 0;
const server = createServer((req, res) => {
  if (req.url === "/api/upload") {
    uploads++;
    req.resume();
    req.on("end", () => { res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "UPLOAD_OUTCOME_UNKNOWN" })); });
  } else void app.getRequestHandler()(req, res);
});
const io = new Server(server);
io.on("connection", socket => {
  let username = "";
  const snapshot = () => ({ history: [], users: [username] });
  socket.on("join-room", data => {
    username = data.username;
    if (data.password !== "fixture-only") return socket.emit("join-error", "Wrong password");
    socket.emit("room-snapshot", snapshot());
  });
  socket.on("sync-room", (_data, ack) => ack(snapshot()));
  socket.on("send-message", () => { sends++; }); // Deliberately lost ACK, no database write.
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {});
const checks = [], errors = [];
try {
  const context = await browser.newContext();
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const join = async (name = "Owner") => {
    await page.getByLabel("Username", { exact: true }).fill(name);
    await page.getByLabel("Room password (if any)", { exact: true }).fill("fixture-only");
    await page.getByRole("button", { name: "Join Chat", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("online");
  };
  const pending = () => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("dimle-public-outbox-v1", 1);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("pending"); const r = tx.objectStore("pending").getAll();
        r.onsuccess = async () => resolve(await Promise.all(r.result.map(async value => ({
          id: value.clientMessageId, kind: value.kind, outcome: value.outcome,
          payload: typeof value.payload === "string" ? value.payload : Array.from(new Uint8Array(await value.payload.arrayBuffer())),
          name: value.payload.name,
        }))));
        r.onerror = () => reject(r.error);
      });
    } finally { db.close(); }
  });
  await page.goto(base + "/room?id=proof123");
  await join();
  await page.getByLabel("Message", { exact: true }).fill("persisted unsent draft");
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 1, 2]);
  await page.locator("input[type=file]").setInputFiles({ name: "unknown.png", mimeType: "image/png", buffer: bytes });
  await expect(page.getByRole("alert", { name: "Delivery status" })).toContainText("Attachment status is unknown");
  await expect.poll(() => uploads).toBe(1);
  const before = await pending();
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].payload, Array.from(bytes));
  assert.equal(before[0].name, "unknown.png");
  await page.reload(); await join();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("persisted unsent draft");
  await expect(page.getByRole("alert", { name: "Delivery status" })).toContainText("Attachment status is unknown");
  assert.deepEqual(await pending(), before);
  assert.equal(uploads, 1); assert.equal(sends, 0);
  checks.push("real public UI reload restores draft + UNKNOWN file with exact bytes and stable operation ID; zero replay");
  await page.locator("input[type=file]").setInputFiles({ name: "unknown.png", mimeType: "image/png", buffer: bytes });
  await expect(page.getByText(/Upload failed: unknown.png.*Delivery is not confirmed/)).toBeVisible();
  assert.equal(uploads, 1); assert.deepEqual(await pending(), before);
  checks.push("explicit second attachment cannot replace or resend unresolved operation");
  await page.reload(); await join("OtherOwner");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await expect(page.getByRole("alert", { name: "Delivery status" })).toHaveCount(0);
  assert.deepEqual(await pending(), before);
  checks.push("different username does not restore another owner draft or pending UI; retained record preserved");
  await page.getByLabel("Message", { exact: true }).fill("unknown text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await page.reload(); await join("OtherOwner");
  await expect(page.getByRole("alert", { name: "Delivery status" })).toContainText("Delivery is not confirmed");
  const withText = await pending();
  assert.equal(withText.length, 2);
  assert.equal(withText.find(x => x.kind === "text").payload, "unknown text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Delivery is not confirmed.*Check room history;/)).toBeVisible();
  assert.equal(sends, 1);
  checks.push("lost text ACK survives reload with original payload/ID; explicit retry blocked");

  const deniedContext = await browser.newContext();
  await deniedContext.addInitScript(() => {
    IDBFactory.prototype.open = () => { throw new DOMException("Denied", "SecurityError"); };
  });
  const denied = await deniedContext.newPage();
  denied.on("pageerror", e => errors.push(e.message));
  await denied.goto(base + "/room?id=proof123");
  await denied.getByLabel("Username", { exact: true }).fill("Denied");
  await denied.getByLabel("Room password (if any)", { exact: true }).fill("fixture-only");
  await denied.getByRole("button", { name: "Join Chat", exact: true }).click();
  await expect(denied.getByRole("alert", { name: "Delivery status" })).toContainText("Sending is blocked");
  await denied.locator("input[type=file]").setInputFiles({ name: "denied.png", mimeType: "image/png", buffer: bytes });
  await expect(denied.getByText(/Upload failed: denied.png.*Nothing was sent/)).toBeVisible();
  assert.equal(uploads, 1);
  checks.push("denied IndexedDB fails closed before upload");
  await deniedContext.close();

  const quotaContext = await browser.newContext();
  await quotaContext.addInitScript(() => {
    IDBObjectStore.prototype.put = () => { throw new DOMException("Full", "QuotaExceededError"); };
  });
  const quota = await quotaContext.newPage();
  quota.on("pageerror", e => errors.push(e.message));
  await quota.goto(base + "/room?id=proof123");
  await quota.getByLabel("Username", { exact: true }).fill("Quota");
  await quota.getByLabel("Room password (if any)", { exact: true }).fill("fixture-only");
  await quota.getByRole("button", { name: "Join Chat", exact: true }).click();
  await expect(quota.getByRole("status")).toContainText("online");
  await quota.locator("input[type=file]").setInputFiles({ name: "full.png", mimeType: "image/png", buffer: bytes });
  await expect(quota.getByText(/Upload failed: full.png.*Full/)).toBeVisible();
  assert.equal(uploads, 1);
  checks.push("quota failure aborts reservation before upload without uncaught errors");
  await quotaContext.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", checks, uploads, sends, pageErrors: errors, browser: browser.version(), scope: "Built public UI + loopback controlled protocol; not real database/candidate acceptance" }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise(resolve => io.close(resolve));
  server.closeAllConnections();
  await app.close();
}
