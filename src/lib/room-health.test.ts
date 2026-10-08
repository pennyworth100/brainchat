import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { createRoomSession, type ConnectionState } from "./room-session";

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

for (const mode of ["current", "legacy", "lost", "rejected", "empty"] as const) {
  test(`periodic membership health: ${mode}`, async (t) => {
    const server = http.createServer();
    const ioServer = new Server(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const snapshot = { history: [], users: ["qa"] };
    let joins = 0;
    let healthChecks = 0;
    let fullSyncs = 0;
    ioServer.on("connection", (socket) => {
      socket.on("join-room", () => { joins++; socket.emit("room-snapshot", snapshot); });
      socket.on("sync-room", (payload, ack) => {
        if (!payload.probeOnly) { fullSyncs++; ack(snapshot); return; }
        healthChecks++;
        if (mode === "current") ack({ ok: true });
        if (mode === "legacy") ack(snapshot);
        if (mode === "rejected") ack({ error: "Rejoin the room" });
        if (mode === "empty") ack({});
      });
    });
    const socket = io(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const states: ConnectionState[] = [];
    let snapshots = 0;
    let joinedNotifications = 0;
    const session = createRoomSession(socket, {
      onState: (state) => states.push(state),
      onSnapshot: () => { snapshots++; },
      onJoined: () => { joinedNotifications++; },
      onError: assert.fail,
    }, 100);
    t.after(async () => {
      session.dispose(); socket.disconnect();
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    });
    await assert.rejects(session.checkHealth(), /Join the room/);
    session.join({ roomId: "qa", username: "qa" });
    await waitFor(() => session.isReady());
    const oldId = socket.id;
    states.length = 0;
    const first = session.checkHealth();
    assert.equal(session.checkHealth(), first, "overlapping ticks share one in-flight request");
    assert.equal(session.isReady(), true, "a pending periodic probe does not disable the editor");
    const id = await first;
    assert.equal(healthChecks, 1);
    assert.equal(fullSyncs, 0, "a health tick never fetches a snapshot");
    assert.equal(session.isReady(), true);
    if (mode === "current" || mode === "legacy") {
      assert.equal(id, oldId);
      assert.equal(joins, 1);
      assert.equal(snapshots, 1);
      assert.equal(joinedNotifications, 1);
      assert.deepEqual(states, [], "healthy probe must not flash syncing or ready");
    } else {
      assert.notEqual(id, oldId);
      assert.equal(joins, 2, "failed membership check must reauthenticate");
      assert.equal(snapshots, 2, "recovery still backfills full history");
      assert.ok(states.includes("reconnecting"));
      assert.ok(states.includes("syncing"));
    }
    await session.sync();
    assert.equal(fullSyncs, 1, "explicit foreground/pre-send sync still fetches history");
  });
}

test("a stale health rejection cannot disconnect the replacement socket", async (t) => {
  const server = http.createServer();
  const ioServer = new Server(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let joins = 0;
  let delayedAck: ((value: unknown) => void) | undefined;
  ioServer.on("connection", (socket) => {
    socket.on("join-room", () => { joins++; socket.emit("room-snapshot", { history: [], users: ["qa"] }); });
    socket.on("sync-room", (_payload, ack) => { delayedAck = ack; });
  });
  const socket = io(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const session = createRoomSession(socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError: assert.fail,
  }, 250);
  t.after(async () => {
    session.dispose(); socket.disconnect();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  });
  session.join({ roomId: "qa", username: "qa" });
  await waitFor(() => session.isReady());
  const pending = session.checkHealth();
  await waitFor(() => !!delayedAck);
  const replacement = await session.reconnect();
  delayedAck!({ error: "Rejoin the room" });
  assert.equal(await pending, replacement);
  assert.equal(joins, 2);
  assert.equal(socket.id, replacement);
  assert.equal(session.isReady(), true);
});
