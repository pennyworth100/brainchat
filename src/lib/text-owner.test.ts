import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Socket } from "socket.io-client";
import { createRoomSession } from "./room-session";
import { createTextSender } from "./text-message-client";

function fixture() {
  const events = new EventEmitter();
  const syncAcks: Array<(err: Error | null, result: unknown) => void> = [];
  const textAcks: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; packet: any }> = [];
  let connections = 0;
  const socket = {
    connected: false, id: "",
    on: events.on.bind(events), off: events.off.bind(events),
    connect() { this.connected = true; this.id = "transport-" + ++connections; events.emit("connect"); },
    disconnect() { this.connected = false; events.emit("disconnect"); },
    emit() { events.emit("room-snapshot", { history: [], users: [], capabilities: { textOperationKeys: true } }); },
    get volatile() { return this; },
    timeout() { return this; },
    emitWithAck(_event: string, packet: any) {
      return new Promise((resolve, reject) => textAcks.push({ resolve, reject, packet }));
    },
  };
  // Room sync uses callback-style ACK; message sending uses a Promise ACK.
  const joinEmit = socket.emit.bind(socket);
  socket.emit = ((event: string, _payload: unknown, ack: typeof syncAcks[number]) => {
    if (event === "sync-room") syncAcks.push(ack);
    else joinEmit();
  }) as typeof socket.emit;
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError() {},
  });
  session.join({ roomId: "original", username: "first" });
  const sender = createTextSender(() => "original-key", 50);
  return { session, socket, events, textAcks,
    send: () => sender.send(socket as unknown as Socket, session, "original", "hello"),
    sync() { syncAcks.shift()!(null, { history: [], users: [] }); },
    receipt() { const a = textAcks[0]; a.resolve({ clientMessageId: a.packet.clientMessageId,
      message: { id: 7, type: "message", username: "first", message: "hello", ts: 1 } }); },
    change(kind: string) {
      if (kind === "dispose") session.dispose();
      else if (kind === "terminal") events.emit("join-error", "Wrong password");
      else session.join({ roomId: kind === "same" ? "original" : "other", username: "replacement" });
    },
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const change of ["same", "different", "terminal", "dispose"]) {
  test("text owner: late error after " + change + " reports revoked owner", async t => {
    const f = fixture(); t.after(() => f.session.dispose());
    const sent = f.send();
    const outcome = assert.rejects(sent, /Room (changed|closed)/);
    f.sync(); await tick();
    f.change(change);
    f.textAcks[0].reject(new Error("late transport failure"));
    await outcome;
  });
}

for (const change of ["same", "different", "terminal", "dispose"]) {
  test("text owner: " + change + " between sync completion and emit blocks the packet", async t => {
    const f = fixture(); t.after(() => f.session.dispose());
    const sent = f.send();
    const outcome = sent.then(value => ({ value, error: null as Error | null }), error => ({ value: null, error: error as Error }));
    f.sync(); f.change(change);
    await tick();
    // Settle even a buggy baseline to avoid a false cancellation PASS.
    if (f.textAcks.length) f.receipt();
    assert.match((await outcome).error?.message ?? "resolved unexpectedly", /Room/);
    assert.equal(f.textAcks.length, 0);
  });
  test("text owner: late ACK after " + change + " cannot publish a receipt", async t => {
    const f = fixture(); t.after(() => f.session.dispose());
    const sent = f.send();
    const outcome = sent.then(value => ({ value, error: null as Error | null }), error => ({ value: null, error: error as Error }));
    f.sync(); await tick();
    assert.equal(f.textAcks.length, 1);
    f.change(change); f.receipt();
    assert.match((await outcome).error?.message ?? "resolved unexpectedly", /Room (changed|closed)/);
  });
}
test("text owner: transport-only change may confirm the original write, but never replays it", async t => {
  const f = fixture(); t.after(() => f.session.dispose());
  const sent = f.send(); f.sync(); await tick();
  f.socket.disconnect(); f.socket.connect();
  f.receipt();
  assert.equal((await sent).id, 7);
  assert.equal(f.textAcks.length, 1);
});
test("text owner: revoked uncertain operation fails before probing replacement even if transport id repeats", async t => {
  const f = fixture(); t.after(() => f.session.dispose());
  const sent = f.send();
  const lost = assert.rejects(sent, /lost ACK/);
  f.sync(); await tick();
  const transport = f.socket.id;
  f.textAcks[0].reject(new Error("lost ACK")); await lost;
  f.change("same"); f.socket.id = transport;
  const retried = f.send();
  const outcome = assert.rejects(retried, /Room changed/);
  // Buggy baseline probes and then emits: settle both, never hang.
  if (!f.session.isReady()) f.sync();
  await tick();
  if (f.textAcks.length > 1) f.textAcks[1].resolve({ clientMessageId: "original-key",
    message: { id: 7, type: "message", username: "first", message: "hello", ts: 1 } });
  await outcome;
  assert.equal(f.session.isReady(), true);
  assert.equal(f.textAcks.length, 1);
});
