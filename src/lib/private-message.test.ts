import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { registerPrivateMessages } from "./private-message";
import { sendPrivateMessage } from "./private-message-client";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext) {
  const httpServer = http.createServer();
  const server = new Server(httpServer);
  const users = new Map<string, Map<string, string>>();
  server.on("connection", socket => {
    const room = String(socket.handshake.auth.room || "qa");
    socket.join(room);
    if (!users.has(room)) users.set(room, new Map());
    users.get(room)!.set(socket.id, String(socket.handshake.auth.name));
    registerPrivateMessages(server, socket, users, 80);
  });
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const clients: Socket[] = [];
  t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise<void>(resolve => server.close(() => resolve())); });
  async function connect(name: string, room = "qa") {
    const socket = io(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`, { auth: { name, room }, transports: ["websocket"] });
    clients.push(socket);
    await new Promise<void>(resolve => socket.once("connect", resolve));
    return socket;
  }
  const sender = await connect("Sender");
  const recipient = await connect("Mobile");
  const outsider = await connect("Outsider", "other");
  const sent: unknown[] = [], leaked: unknown[] = [];
  sender.on("private-message-sent", data => sent.push(data));
  outsider.on("private-message", data => leaked.push(data));
  const send = (toUsername = "Mobile") => sendPrivateMessage(sender, { roomId: "qa", toUsername, message: "keep this draft" }, 500);
  return { server, users, connect, sender, recipient, outsider, sent, leaked, send };
}

test("DM success requires receiver ACK; duplicate ACK cannot duplicate sent event; outsiders isolated", async t => {
  const f = await fixture(t);
  let received = 0;
  f.recipient.on("private-message", (data, ack) => { received++; assert.equal(data.message, "keep this draft"); ack({ received: true }); ack({ received: true }); });
  await f.send();
  await delay(20);
  assert.equal(received, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.leaked.length, 0);
});

test("half-open/unresponsive recipient cannot report sent; no retry or broadcast", async t => {
  const f = await fixture(t);
  // Socket remains connected, as during the heartbeat grace period.
  let received = 0;
  f.recipient.on("private-message", () => received++);
  await assert.rejects(f.send(), /Delivery not confirmed/);
  await delay(100);
  assert.equal(f.recipient.connected, true);
  assert.equal(received, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.leaked.length, 0);
});

test("late receiver ACK cannot turn an expired send into success", async t => {
  const f = await fixture(t);
  let acknowledge: ((data: unknown) => void) | undefined;
  f.recipient.on("private-message", (_data, ack) => { acknowledge = ack; });
  await assert.rejects(f.send(), /Delivery not confirmed/);
  acknowledge!({ received: true });
  await delay(30);
  assert.equal(f.sent.length, 0);
});

test("malformed ACK is not delivery", async t => {
  const f = await fixture(t);
  f.recipient.on("private-message", (_data, ack) => ack({ received: "true" }));
  await assert.rejects(f.send(), /Delivery not confirmed/);
  assert.equal(f.sent.length, 0);
});

test("resumed ghost and genuine namesakes both fail closed without fanout or eviction", async t => {
  const f = await fixture(t);
  const namesake = await f.connect("Mobile");
  let deliveries = 0;
  for (const socket of [f.recipient, namesake]) socket.on("private-message", (_data, ack) => { deliveries++; ack({ received: true }); });
  await assert.rejects(f.send(), /More than one session/);
  assert.equal(deliveries, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.users.get("qa")!.size, 3);
  assert.equal(f.recipient.connected && namesake.connected, true);
  // Once normal heartbeat cleanup removes the old membership, retry is safe
  // for this rejected (never emitted) send, without routing to a new identity.
  f.users.get("qa")!.delete(f.recipient.id!);
  await f.send();
  assert.equal(deliveries, 1);
});

test("offline, cross-room and malformed sends return errors without disclosure", async t => {
  const f = await fixture(t);
  await assert.rejects(f.send("Absent"), /offline/);
  const unauthorized = await f.outsider.timeout(500).emitWithAck("private-message", { roomId: "qa", toUsername: "Mobile", message: "secret" });
  assert.match(unauthorized.error, /Rejoin/);
  const invalid = await f.sender.timeout(500).emitWithAck("private-message", null);
  assert.match(invalid.error, /Invalid/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.leaked.length, 0);
});

test("sender-side timeout stays uncertain and disconnected send is never buffered", async t => {
  const f = await fixture(t);
  await assert.rejects(sendPrivateMessage(f.sender, { roomId: "qa", toUsername: "Mobile", message: "draft" }, 10), /Delivery not confirmed/);
  f.sender.disconnect();
  await assert.rejects(f.send(), /has not been sent/);
  assert.equal(f.sender.sendBuffer.length, 0);
});
