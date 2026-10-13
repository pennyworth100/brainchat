import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { EventEmitter } from "node:events";
import { createRoomSession } from "./room-session";

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// Deliberately retain old transport callbacks so late delivery can be tested
// independently of Socket.IO's normal disconnect-time ACK cancellation.
function delayedTransport(textOperationKeys = false) {
  const events = new EventEmitter();
  const acks: Array<(error: Error | null, result?: unknown) => void> = [];
  let connections = 0;
  const socket = {
    connected: false, id: "",
    on: events.on.bind(events), off: events.off.bind(events),
    connect() {
      socket.connected = true; socket.id = `transport-${++connections}`;
      events.emit("connect");
    },
    disconnect() { socket.connected = false; events.emit("disconnect"); },
    emit() { events.emit("room-snapshot", { history: [], users: [], capabilities: { textOperationKeys } }); },
    timeout() { return { emit(_event: string, _payload: unknown, ack: typeof acks[number]) { acks.push(ack); } }; },
  };
  let snapshots = 0;
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() { snapshots++; }, onJoined() {}, onError() {},
  });
  return { socket, session, acks, events, snapshots: () => snapshots };
}

for (const kind of ["sync", "checkHealth"] as const) {
  test(`${kind}: transport-only reconnect retains the same room owner`, async (t) => {
    const f = delayedTransport();
    t.after(() => f.session.dispose());
    f.session.join({ roomId: "same", username: "first" });
    const pending = f.session[kind]();
    const oldId = f.socket.id;
    f.socket.disconnect(); f.socket.connect();
    f.acks[0](new Error("old transport timed out"));
    assert.notEqual(f.socket.id, oldId);
    assert.equal(await pending, f.socket.id);
    assert.equal(f.session.isReady(), true);
  });

  for (const staleError of [false, true]) {
    test(`${kind}: late ${staleError ? "failure" : "snapshot"} cannot affect replacement probe`, async (t) => {
      const f = delayedTransport();
      t.after(() => f.session.dispose());
      f.session.join({ roomId: "same", username: "first" });
      const old = assert.rejects(f.session[kind](), /Room changed/);
      f.session.join({ roomId: "same", username: "second" });
      const current = f.session[kind]();
      await old; // Old finally runs AFTER replacement creation.
      assert.equal(f.session[kind](), current, "old cleanup must not evict the replacement cache");
      const snapshots = f.snapshots();
      const transport = f.socket.id;
      f.acks[0](staleError ? new Error("late timeout") : null, {
        history: [], users: ["stale"], capabilities: { textOperationKeys: true },
      });
      assert.equal(f.snapshots(), snapshots, "late snapshot must not publish");
      assert.equal(f.socket.id, transport, "late error must not restart the replacement");
      assert.equal(f.session.canRetryText(), false, "late capability must not grant authority");
      assert.equal(f.session[kind](), current);
      assert.equal(f.acks.length, 2);
      f.acks[1](null, { history: [], users: [] });
      assert.equal(await current, transport);
      assert.equal(f.session.isReady(), true);
    });
  }

  for (const ending of ["dispose", "terminal"] as const) {
    test(`${kind}: ${ending} promptly rejects a silent in-flight probe`, async (t) => {
      const f = delayedTransport();
      t.after(() => f.session.dispose());
      f.session.join({ roomId: "same", username: "first" });
      const pending = assert.rejects(f.session[kind](), ending === "dispose" ? /Room closed/ : /Wrong password/);
      if (ending === "dispose") f.session.dispose();
      else f.events.emit("join-error", "Wrong password");
      await pending; // No ACK and no timer advance is needed to settle the call.
      const snapshots = f.snapshots();
      f.acks[0](null, { history: [], users: ["stale"] });
      assert.equal(f.snapshots(), snapshots);
      assert.equal(f.session.isReady(), false);
      await assert.rejects(f.session[kind]());
    });
  }
}

for (const change of ["same", "different", "terminal", "dispose"]) {
  test(`captured upload owner rejects ${change} after successful sync`, async t => {
    const f = delayedTransport();
    t.after(() => f.session.dispose());
    f.session.join({ roomId: "same", username: "first" });
    const check = f.session.operationGuard("same");
    const syncing = f.session.sync();
    f.acks[0](null, { history: [], users: [] });
    await syncing;
    check();
    if (change === "dispose") f.session.dispose();
    else if (change === "terminal") f.events.emit("join-error", "Wrong password");
    else f.session.join({ roomId: change, username: "second" });
    assert.throws(check, /Room (changed|closed)/);
  });
}

test("upload owner is room-bound and survives only transport recovery", async t => {
  const f = delayedTransport();
  t.after(() => f.session.dispose());
  f.session.join({ roomId: "same", username: "first" });
  assert.throws(() => f.session.operationGuard("other"), /Room changed/);
  const check = f.session.operationGuard("same");
  await f.session.reconnect();
  check();
});

test("disposal revokes ready/text/upload authority without relying on socket disconnect", () => {
  const f = delayedTransport(true);
  f.session.join({ roomId: "same", username: "first" });
  assert.equal(f.session.isReady(), true);
  assert.equal(f.session.canRetryText(), true);
  f.session.dispose();
  assert.equal(f.socket.connected, true);
  assert.equal(f.session.isReady(), false);
  assert.equal(f.session.canRetryText(), false);
  assert.equal(f.session.uploadAuthority("same", f.socket.id), null);
});

for (const kind of ["sync", "checkHealth"] as const) {
  for (const nextRoom of ["original", "different"]) {
    test(`${kind}: explicit rejoin to ${nextRoom} rejects old-session work`, async (t) => {
      const server = http.createServer();
      const sockets = new Server(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      let probes = 0;
      let acknowledge = false;
      sockets.on("connection", (socket) => {
        socket.on("join-room", () => socket.emit("room-snapshot", { history: [], users: [] }));
        socket.on("sync-room", (_payload, ack) => {
          probes++;
          if (acknowledge) ack({ history: [], users: [] });
        });
      });
      const socket = io(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const session = createRoomSession(socket, {
        onState() {}, onSnapshot() {}, onJoined() {}, onError: assert.fail,
      }, 200);
      t.after(async () => {
        session.dispose(); socket.disconnect();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
      });
      session.join({ roomId: "original", username: "first" });
      await waitFor(() => session.isReady());
      const old = session[kind]();
      assert.equal(session[kind](), old, "one in-flight probe per current session");
      const outcome = old.then(
        (id) => ({ id, error: "" }),
        (error: Error) => ({ id: "", error: error.message }),
      );
      await waitFor(() => probes === 1);
      session.join({ roomId: nextRoom, username: "second" });
      await waitFor(() => session.isReady());
      assert.deepEqual(await outcome, { id: "", error: "Room changed" },
        "an old pre-send/liveness check must never authorize a new explicit session");
      acknowledge = true;
      assert.equal(await session[kind](), socket.id);
      assert.equal(probes, 2, "new session must issue its own probe");
    });
  }
}
