import assert from "node:assert/strict";
import test from "node:test";
import type { Socket } from "socket.io-client";
import { createTextSender } from "./text-message-client";

function fixture(maxPending = 32) {
  let next = 0, calls = 0, capable = true, ready = true;
  const packets: any[] = [];
  let respond = async (packet: any): Promise<any> => ({
    clientMessageId: packet.clientMessageId,
    message: { id: ++calls, type: "message", username: "Alice", message: packet.message, ts: 1 },
  });
  const wire = {
    connected: true, id: "transport-a",
    get volatile() { return this; },
    timeout() { return this; },
    async emitWithAck(event: string, packet: any) {
      assert.equal(event, "send-message");
      packets.push(packet);
      return respond(packet);
    },
  };
  const session = {
    sync: async () => wire.id,
    isReady: () => ready,
    canRetryText: () => capable,
  };
  const sender = createTextSender(() => "key-" + ++next, 50, maxPending);
  return { wire, session, packets, sender,
    send: (text = "hello", room = "qa") => sender.send(wire as unknown as Socket, session, room, text),
    respond: (fn: typeof respond) => { respond = fn; },
    capability: (value: boolean) => { capable = value; },
    ready: (value: boolean) => { ready = value; },
  };
}

test("lost ACK retains one immutable operation key; confirmed same text is a new operation", async () => {
  const f = fixture();
  let attempts = 0;
  f.respond(async p => {
    if (++attempts === 1) throw new Error("operation has timed out");
    return { clientMessageId: p.clientMessageId,
      message: { id: 7, type: "message", username: "Alice", message: p.message, ts: 1 } };
  });
  await assert.rejects(f.send(), /timed out/);
  await f.send();
  assert.equal(f.packets[0].clientMessageId, f.packets[1].clientMessageId);
  await f.send();
  assert.notEqual(f.packets[1].clientMessageId, f.packets[2].clientMessageId);
});

test("reconnect cannot replay uncertain text into a new logical session", async () => {
  const f = fixture();
  f.respond(async () => { throw Error("lost ACK"); });
  await assert.rejects(f.send(), /lost ACK/);
  f.wire.id = "transport-b";
  await assert.rejects(f.send(), /cannot be retried after reconnecting/);
  assert.equal(f.packets.length, 1);
});

test("a replacement session controller cannot reuse an uncertain transport receipt", async () => {
  const f = fixture();
  f.respond(async () => { throw Error("lost ACK"); });
  await assert.rejects(f.send());
  await assert.rejects(f.sender.send(f.wire as unknown as Socket, { ...f.session }, "qa", "hello"), /cannot be retried/);
  assert.equal(f.packets.length, 1);
});

test("old servers remain single-attempt compatible and never gain uncertain retries", async () => {
  const f = fixture();
  f.capability(false);
  f.respond(async p => ({ message: { id: 1, type: "message", username: "Alice", message: p.message, ts: 1 } }));
  await f.send();
  f.respond(async () => { throw Error("lost ACK"); });
  await assert.rejects(f.send());
  await assert.rejects(f.send(), /cannot be retried/);
  assert.equal(f.packets.length, 2);
});

test("editing and then returning to an uncertain draft retains its original key", async () => {
  const f = fixture();
  f.respond(async () => { throw Error("lost ACK"); });
  await assert.rejects(f.send("first"));
  await assert.rejects(f.send("second"));
  await assert.rejects(f.send("first"));
  assert.equal(f.packets[0].clientMessageId, f.packets[2].clientMessageId);
  assert.notEqual(f.packets[0].clientMessageId, f.packets[1].clientMessageId);
});

test("mismatched and malformed receipts cannot retire an operation", async () => {
  for (const receipt of [null, {}, { error: "unknown", outcome: "unknown" },
    { clientMessageId: "wrong", message: { id: 2, type: "message", username: "Alice", message: "hello", ts: 1 } },
    { clientMessageId: "key-1", message: { id: 2, type: "message", username: "Alice", message: "other", ts: 1 } }]) {
    const f = fixture();
    f.respond(async () => receipt);
    await assert.rejects(f.send());
    await assert.rejects(f.send());
    assert.equal(f.packets[0].clientMessageId, f.packets[1].clientMessageId);
  }
});

test("pending capacity fails closed without evicting unknown operations", async () => {
  const f = fixture(2);
  f.respond(async () => { throw Error("lost ACK"); });
  await assert.rejects(f.send("one"));
  await assert.rejects(f.send("two"));
  await assert.rejects(f.send("three"), /Too many unconfirmed/);
  await assert.rejects(f.send("one"));
  assert.equal(f.packets.length, 3);
  assert.equal(f.packets[0].clientMessageId, f.packets[2].clientMessageId);
});

test("sync failure before emit frees pending capacity and cannot enqueue a socket packet", async () => {
  const f = fixture(1);
  f.session.sync = async () => { throw Error("sync failed"); };
  await assert.rejects(f.send("one"), /sync failed/);
  f.session.sync = async () => f.wire.id;
  await f.send("two");
  assert.equal(f.packets.length, 1);
});

test("readiness or transport changes between sync and emit never buffer a packet", async () => {
  for (const change of ["disconnect", "id", "ready"]) {
    const f = fixture();
    f.session.sync = async () => {
      if (change === "disconnect") f.wire.connected = false;
      if (change === "id") f.wire.id = "other";
      if (change === "ready") f.ready(false);
      return "transport-a";
    };
    await assert.rejects(f.send(), /reconnecting/);
    assert.equal(f.packets.length, 0);
  }
});

test("concurrent sends cannot overlap the operation authority check", async () => {
  const f = fixture();
  let release!: () => void;
  f.session.sync = () => new Promise(resolve => { release = () => resolve(f.wire.id); });
  const first = f.send();
  await assert.rejects(f.send(), /already being sent/);
  release();
  await first;
  assert.equal(f.packets.length, 1);
});

