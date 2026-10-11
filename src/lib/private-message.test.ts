import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { registerPrivateMessages } from "./private-message";
import { sendPrivateMessage } from "./private-message-client";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings, type ResumeBinding } from "./resume-bindings";
import { ResumeMemberships } from "./resume-membership";
import { attachResumeSocket } from "./resume-socket";
import { ResumeOperationGate } from "./resume-operation";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: TestContext) {
  const httpServer = http.createServer();
  const server = new Server(httpServer);
  const bindings = new ResumeBindings();
  const members = new ResumeMemberships(bindings);
  const identities = new Map<string, ResumeBinding>();
  const revoked = new Set<string>();
  const gate = new ResumeOperationGate({ connect: async () => {
    const events = new EventEmitter();
    return { on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      query: async (sql: string, args?: string[]) => ({ rowCount:
        sql.includes("SELECT s.id") && revoked.has(args![0]) ? 0 : 1 }), release: () => {},
    } as unknown as PoolClient;
  } } as Pick<Pool, "connect">, bindings);
  server.on("connection", async socket => {
    const room = String(socket.handshake.auth.room || "qa");
    const owner = attachResumeSocket(socket, { bindings, store: { advanceGeneration: async () => null },
      prepare: async () => async () => {}, onCleanupError: () => {} });
    const binding = await bindings.activate({ sessionId: socket.id, roomId: room,
      username: String(socket.handshake.auth.name), authVersion: 1, generation: 1,
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    }, owner.incarnation, async () => {}, () => socket.connected);
    assert.ok(binding);
    assert.ok(members.install(socket, owner, binding));
    identities.set(socket.id, binding);
    registerPrivateMessages(socket, owner, members, gate, 80);
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
  const invalidate = (socket: Socket) => bindings.detach(identities.get(socket.id!)!);
  const revoke = (socket: Socket) => revoked.add(identities.get(socket.id!)!.sessionId);
  return { server, members, invalidate, revoke, connect, sender, recipient, outsider, sent, leaked, send };
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
  assert.equal(f.members.presence("qa").count, 3);
  assert.equal(f.recipient.connected && namesake.connected, true);
  // Once normal heartbeat cleanup removes the old membership, retry is safe
  // for this rejected (never emitted) send, without routing to a new identity.
  f.invalidate(f.recipient);
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

for (const endpoint of ["sender", "recipient"] as const) {
  test(`durably revoked ${endpoint} cannot emit a private payload`, async t => {
    const f = await fixture(t);
    let deliveries = 0;
    f.recipient.on("private-message", (_data, ack) => { deliveries++; ack({ received: true }); });
    f.revoke(f[endpoint]);
    await assert.rejects(f.send(), /Rejoin/);
    assert.equal(deliveries, 0);
    assert.equal(f.sent.length, 0);
  });
  for (const change of ["invalidate", "revoke"] as const) {
    test(`${endpoint} ${change} during recipient ACK cannot report sent or replay`, async t => {
      const f = await fixture(t);
      let deliveries = 0;
      f.recipient.on("private-message", (_data, ack) => {
        deliveries++;
        f[change](f[endpoint]);
        ack({ received: true });
      });
      await assert.rejects(f.send(), /Delivery not confirmed/);
      assert.equal(deliveries, 1);
      assert.equal(f.sent.length, 0);
      assert.equal(f.leaked.length, 0);
    });
  }
}
