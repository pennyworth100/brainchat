import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";
import { canonicalResumeImage, MAX_RESUME_IMAGE_DATA_URL_LENGTH, ResumeImageWriter } from "./resume-image";

const image = "data:image/png;base64,aGVsbG8=";
test("image canonicalization bounds and strict base64, without paths or fetches", () => {
  assert.equal(canonicalResumeImage(image.toUpperCase().split(",")[0] + ",aGVsbG8="), image);
  for (const mime of ["png", "jpeg", "gif", "webp"]) {
    assert.equal(canonicalResumeImage(`data:image/${mime};base64,YQ==`), `data:image/${mime};base64,YQ==`);
  }
  const header = "data:image/png;base64,";
  const largestBody = "a".repeat(Math.floor((MAX_RESUME_IMAGE_DATA_URL_LENGTH - header.length) / 4) * 4);
  assert.equal(canonicalResumeImage(header + largestBody).length, header.length + largestBody.length);
  assert.throws(() => canonicalResumeImage(header + largestBody + "aaaa"), /Invalid resume image/);
  for (const bad of [null, {}, "", "https://example.com/image.png", "/uploads/a.png",
    "data:image/svg+xml;base64,YQ==", "data:image/png;base64,", "data:image/png;base64,YQ",
    "data:image/png;base64,YQ===", "data:image/png;base64,YR==", "data:image/png;base64,Y Q=",
    "data:image/png;base64,YQ==\n", "data:image/png;base64,====",
    "data:image/png;base64," + "a".repeat(MAX_RESUME_IMAGE_DATA_URL_LENGTH)]) {
    assert.throws(() => canonicalResumeImage(bad), /Invalid resume image/);
  }
});

for (const mode of ["new", "retry", "uncertain", "tombstone", "wrong-room", "wrong-type",
  "changed-content", "invalid-time", "conflict", "policy-denied", "copied-binding", "invalid-key", "invalid-image"]) {
  test("image receipt: " + mode, async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({ sessionId: "fixture", roomId: "candy986",
      username: "Guest", authVersion: 1, generation: 1, issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000) }, "transport_A_123456", async () => {}, () => true);
    assert.ok(binding);
    const row = { id: mode === "tombstone" ? null : 9,
      room_id: mode === "wrong-room" ? "alien123" : "candy986", username: "Guest",
      type: mode === "wrong-type" ? "message" : "image",
      content: JSON.stringify({ dataUrl: mode === "changed-content" ? "corrupt" : image }),
      ts: mode === "invalid-time" ? new Date(NaN) : new Date(1234),
      payload_hash: mode === "conflict" ? "wrong" : createHash("sha256")
        .update(JSON.stringify(["candy986", "Guest", "image", image])).digest("hex") };
    let reach!: () => void, release!: () => void, connects = 0, inserts = 0, destroyed = false;
    const reached = new Promise<void>(r => { reach = r; });
    const finish = new Promise<void>(r => { release = r; });
    const calls: string[] = [];
    const events = new EventEmitter();
    const client = { on: events.on.bind(events), removeListener: events.removeListener.bind(events), query: async (sql: string, args?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("SELECT r.payload_hash")) return { rows: ["new", "uncertain"].includes(mode) ? [] : [row] };
      if (sql.startsWith("INSERT INTO messages")) {
        inserts++;
        assert.deepEqual(args, ["candy986", "Guest", JSON.stringify({ dataUrl: image })]);
        return { rows: [row] };
      }
      if (sql === "COMMIT") { reach(); await finish; if (mode === "uncertain") throw new Error("lost commit ack"); }
      return { rows: [], rowCount: mode === "policy-denied" ? 0 : 1 };
    }, release: (error: boolean) => { destroyed = error; } } as unknown as PoolClient;
    const writer = new ResumeImageWriter(new ResumeOperationGate({ connect: async () => {
      connects++; return client;
    } } as Pick<Pool, "connect">, bindings));
    const pending = writer.saveOnceWithOutcome(mode === "copied-binding" ? { ...binding } : binding,
      mode === "invalid-key" ? "key\n" : "key", mode === "invalid-image" ? "/tmp/image" : image);
    if (["new", "retry", "uncertain"].includes(mode)) {
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await reached; assert.equal(settled, false); release();
      if (mode === "uncertain") await assert.rejects(pending, /lost commit ack/);
      else assert.deepEqual(await pending, { authorized: true, value: { inserted: mode === "new",
        message: { id: 9, type: "image", username: "Guest", dataUrl: image, ts: 1234 } } });
      assert.equal(inserts, mode === "retry" ? 0 : 1);
      assert.equal(calls.filter(sql => sql === "COMMIT").length, 1);
      assert.equal(destroyed, mode === "uncertain");
    } else if (["policy-denied", "copied-binding"].includes(mode)) {
      assert.deepEqual(await pending, { authorized: false });
      assert.equal(calls.some(sql => sql.includes("SELECT r.payload_hash")), false);
      if (mode === "copied-binding") assert.equal(connects, 0);
    } else {
      await assert.rejects(pending, /invalid|Invalid|conflict|no longer available/);
      assert.equal(inserts, 0); assert.ok(calls.includes("ROLLBACK"));
      assert.ok(!calls.includes("COMMIT"));
    }
  });
}
