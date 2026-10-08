import assert from "node:assert/strict";
import test from "node:test";
import { createDimleClient, parseDimleTarget } from "../src/client.js";

test("client authenticates reads and sends an idempotency key without a username", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(
      options.method === "POST"
        ? { ok: true, message: { id: 42 }, deduplicated: false }
        : { messages: [{ id: 41 }] }
    ), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = createDimleClient({ baseUrl: "https://dimle.test/", apiKey: "secret-key-123456" });
    assert.deepEqual(await client.getMessages("spoon651", 40), [{ id: 41 }]);
    await client.sendMessage({ roomId: "spoon651", text: "hello", clientMessageId: "stable-1" });
    assert.equal(calls[0].options.headers["x-api-key"], "secret-key-123456");
    const sent = JSON.parse(calls[1].options.body);
    assert.deepEqual(sent, { roomId: "spoon651", message: "hello", clientMessageId: "stable-1" });
    assert.equal("username" in sent, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("targets are normalized and insecure remote URLs are rejected", () => {
  assert.equal(parseDimleTarget("room:SPOON651"), "spoon651");
  assert.throws(() => parseDimleTarget("../bad"), /Invalid/);
  assert.throws(
    () => createDimleClient({ baseUrl: "http://dimle.test", apiKey: "secret-key-123456" }),
    /HTTPS/
  );
});
