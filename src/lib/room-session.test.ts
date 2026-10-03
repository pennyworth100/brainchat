import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { createRoomSession, mergeMessages, type ChatMessage, type ConnectionState } from "./room-session";

const message = (id: number, text = `message ${id}`): ChatMessage => ({ id, type: "message", username: "same-name", message: text, ts: 123 });
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("history/live/upload overlap reconciles by server ID, not username or timestamp", () => {
  const current = [message(1), message(3), message(4)];
  assert.deepEqual(mergeMessages(current, [message(1), message(2), message(3)]).map((m) => m.id), [1, 2, 3, 4]);
  assert.equal(mergeMessages([message(1, "same")], [message(2, "same")]).length, 2);
});

test("transport reconnect rejoins with credentials, restores missed history and fresh presence", async (t) => {
  const server = http.createServer();
  const sockets = new Server(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let history = [message(1)];
  let joins = 0;
  let ignoreSync = false;
  sockets.on("connection", (socket) => {
    socket.on("join-room", (credentials) => {
      assert.equal(credentials.password, "qa-password");
      joins++;
      socket.join("qa");
      socket.emit("room-snapshot", { history, users: ["mobile", `peer-${joins}`] });
    });
    socket.on("sync-room", (_payload, ack) => {
      if (!ignoreSync) ack({ history, users: ["mobile", `peer-${joins}`] });
    });
  });
  const socket = io(`http://127.0.0.1:${port}`, { reconnectionDelay: 10, randomizationFactor: 0 });
  const states: ConnectionState[] = [];
  let received: ChatMessage[] = [];
  let users: string[] = [];
  const session = createRoomSession(socket, {
    onState: (state) => states.push(state),
    onSnapshot: (snapshot) => { received = mergeMessages(received, snapshot.history); users = snapshot.users; },
    onJoined: () => {}, onError: (error) => assert.fail(error),
  }, 100);
  t.after(async () => { session.dispose(); socket.disconnect(); await new Promise<void>((resolve) => sockets.close(() => resolve())); });
  session.join({ roomId: "qa", username: "mobile", password: "qa-password" });
  await waitFor(() => session.isReady());
  const oldId = socket.id;
  history = [message(1), message(2), message(3)];
  sockets.sockets.sockets.get(oldId!)!.conn.close();
  await waitFor(() => joins === 2 && session.isReady());
  assert.notEqual(socket.id, oldId);
  assert.deepEqual(received.map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(users, ["mobile", "peer-2"]);
  assert.ok(states.includes("reconnecting"));
  await session.sync();
  assert.equal(received.length, 3);
  assert.equal(joins, 2, "healthy resync does not reauthenticate or consume join limits");
  // A stale socket still appears connected, but never acknowledges the probe.
  ignoreSync = true;
  const newId = await session.sync();
  assert.notEqual(newId, oldId);
  assert.equal(joins, 3);
  assert.equal(session.isReady(), true);
  assert.equal(received.length, 3);
});

test("wrong-password failure is not treated as a connected room", async (t) => {
  const server = http.createServer();
  const sockets = new Server(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  sockets.on("connection", (socket) => socket.on("join-room", () => socket.emit("join-error", "Wrong password")));
  const socket = io(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  let error = "";
  const session = createRoomSession(socket, { onState: () => {}, onSnapshot: () => assert.fail("unauthorized history"), onJoined: () => {}, onError: (value) => { error = value; } }, 100);
  t.after(async () => { session.dispose(); socket.disconnect(); await new Promise<void>((resolve) => sockets.close(() => resolve())); });
  session.join({ roomId: "qa", username: "mobile", password: "wrong" });
  await assert.rejects(session.sync(), /Wrong password/);
  assert.equal(error, "Wrong password");
  assert.equal(session.isReady(), false);
});
