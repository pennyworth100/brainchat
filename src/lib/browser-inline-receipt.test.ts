import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBrowserResumeController } from "./browser-resume-controller";
import { browserInlineHash, canonicalBrowserInline, createBrowserInlineReceiptAdapter } from "./browser-inline-receipt";
import { canonicalResumeImage } from "./resume-image";

const lease = { roomId: "candy986", username: "alice", sessionId: "11111111-1111-4111-8111-111111111111",
  token: "A".repeat(43), generation: 1, expiresAt: 5000 };
async function fixture(kind: "message" | "image" = "message", overrideHash?: string) {
  const c = createBrowserResumeController(undefined, () => 1000), physical = {};
  const join = c.beginJoin(lease.roomId, lease.username, physical);
  finish(c, physical, 1, c.accept(join, physical, lease));
  const payload = kind === "message" ? "hello 🌍" : "data:image/png;base64,YQ==";
  const hash = await browserInlineHash(lease.roomId, lease.username, kind, payload);
  const op = c.beginOperation(kind, overrideHash ?? hash);
  const adapter = createBrowserInlineReceiptAdapter(c, op, physical, payload);
  const reply = { clientMessageId: op.clientMessageId, message: { id: 42, type: kind, username: lease.username, ts: 1234,
    ...(kind === "message" ? { message: payload } : { dataUrl: payload }) } };
  return { c, physical, op, adapter, reply, payload, hash };
}
for (const kind of ["message", "image"] as const) {
  test(kind + ": actual wire receipt validates canonical payload, not echoed hashes", async () => {
    const f = await fixture(kind);
    assert.equal(f.hash, createHash("sha256").update(JSON.stringify([lease.roomId, lease.username, kind, f.payload])).digest("hex"));
    assert.equal(await f.adapter.accept({ ...f.reply, payloadHash: "forged", sessionId: "ignored" }), 42);
    assert.equal(f.c.status().pending, 0);
    await assert.rejects(f.adapter.accept(f.reply), /owner/);
  });
  test(kind + ": malformed or mismatched receipts never consume pending work", async () => {
    const f = await fixture(kind);
    for (const value of [null, [], { ok: true }, { ...f.reply, error: "denied" },
      { ...f.reply, clientMessageId: "another-key" },
      ...[{ id: 0 }, { id: 1.5 }, { ts: NaN }, { username: "bob" }, { type: "file" },
        { message: "changed", dataUrl: "data:image/png;base64,Yg==" }].map(change => ({ ...f.reply,
          payloadHash: f.hash, message: { ...f.reply.message, ...change } }))]) {
      await assert.rejects(f.adapter.accept(value));
      assert.equal(f.c.status().pending, 1);
    }
  });
  test(kind + ": old physical ACK cannot settle a same-session resumed operation", async () => {
    const f = await fixture(kind);
    f.c.disconnect(f.physical);
    const second = {}, ticket = f.c.beginResume(second);
    finish(f.c, second, 2, f.c.accept(ticket, second, { ...lease, generation: 2 }));
    await assert.rejects(f.adapter.accept(f.reply), /mismatch/);
    const retry = createBrowserInlineReceiptAdapter(f.c, f.op, second, f.payload);
    assert.equal(retry.request.clientMessageId, f.adapter.request.clientMessageId);
    assert.equal(await retry.accept(f.reply), 42);
  });
}
test("async digest cannot cross explicit rejoin even on identical physical transport", async () => {
  const f = await fixture();
  const pending = f.adapter.accept(f.reply);
  const join = f.c.beginJoin(lease.roomId, lease.username, f.physical);
  finish(f.c, f.physical, 1, f.c.accept(join, f.physical, lease));
  await assert.rejects(pending, /owner/);
});
test("returned content cannot settle an operation created with a different payload hash", async () => {
  const f = await fixture("message", "b".repeat(64));
  await assert.rejects(f.adapter.accept(f.reply), /identity/);
  assert.equal(f.c.status().pending, 1);
});
test("file metadata alone cannot become byte identity proof", async () => {
  const f = await fixture();
  const op = f.c.beginOperation("file", "a".repeat(64));
  assert.throws(() => createBrowserInlineReceiptAdapter(f.c, op, f.physical, "file"), /byte identity/);
});
test("browser image canonicalization agrees with server including padding and bounds", () => {
  for (const value of ["data:IMAGE/PNG;BASE64,YQ==", "data:image/webp;base64,YWJj",
    "data:image/png;base64,YR==", "data:image/png;base64,YQ=", "data:image/png;base64, YQ==",
    "data:image/svg+xml;base64,YQ==", "data:image/png;base64,", "x".repeat(12 * 1024 * 1024 + 1)]) {
    let expected: string;
    try { expected = canonicalResumeImage(value); }
    catch { assert.throws(() => canonicalBrowserInline("image", value)); continue; }
    assert.equal(canonicalBrowserInline("image", value), expected);
  }
});

type Controller = ReturnType<typeof createBrowserResumeController>;
function finish(c: Controller, physical: object, generation: number, ticket: ReturnType<Controller["accept"]>) {
  const adapter = c.snapshot(physical, ticket);
  const completion = adapter.accept({ ...adapter.request, window: "newest-100-id-ascending", history: [], users: [] });
  return c.finishSync(physical, generation, ticket, completion);
}
