import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Socket } from "socket.io-client";
import { createRoomSession } from "./room-session";
import { transientJoinDelay } from "./join-error";

class FakeSocket extends EventEmitter {
  connected = false;
  id = "test-socket";
  joins: unknown[] = [];
  constructor() { super(); this.on("join-room", (data) => this.joins.push({ ...data })); }
  connect() { this.connected = true; this.emit("connect"); return this; }
  disconnect() { this.connected = false; this.emit("disconnect"); return this; }
}
const credentials = { roomId: "apple482", username: "qa", password: "memory-only" };
const snapshot = { history: [], users: ["qa"] };

test("legacy transient strings and typed retryAfter; unknown/auth failures fail closed", () => {
  assert.equal(transientJoinDelay("Server error"), 1000);
  assert.equal(transientJoinDelay("Too many attempts. Try again later."), 60_000);
  assert.equal(transientJoinDelay("limit", { code: "RATE_LIMITED", retryAfterMs: 75_000 }), 75_000);
  assert.equal(transientJoinDelay("limit", { code: "RATE_LIMITED", retryAfterMs: NaN }), 60_000);
  for (const error of ["Wrong password", "Room not found", "Invalid room ID", "Room was already claimed", "unknown"]) {
    assert.equal(transientJoinDelay(error), null);
  }
});

test("cooldown survives transport reconnect and duplicate errors; preserves credentials", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const socket = new FakeSocket();
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError: assert.fail,
  });
  t.after(() => session.dispose());
  session.join(credentials);
  socket.emit("room-snapshot", snapshot);
  socket.disconnect().connect();
  socket.emit("join-error", "limit", { code: "RATE_LIMITED", retryAfterMs: 75_000 });
  socket.emit("join-error", "Server error");
  socket.disconnect().connect();
  t.mock.timers.tick(74_999);
  assert.equal(socket.joins.length, 2);
  assert.equal(session.isReady(), false);
  t.mock.timers.tick(1);
  assert.equal(socket.joins.length, 3);
  assert.deepEqual(socket.joins[2], credentials);
  socket.emit("room-snapshot", snapshot);
  assert.equal(session.isReady(), true);
});

test("three retries then explicit recovery; no automatic reconnect storm", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const socket = new FakeSocket();
  const errors: unknown[] = [];
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError: (...args) => errors.push(args),
  });
  t.after(() => session.dispose());
  session.join(credentials);
  for (const delay of [1000, 2000, 4000]) {
    socket.emit("join-error", "Server error");
    t.mock.timers.tick(delay - 1);
    t.mock.timers.tick(1);
  }
  socket.emit("join-error", "Server error");
  assert.equal(socket.joins.length, 4);
  assert.deepEqual(errors, [["Server error", false]]);
  await assert.rejects(session.reconnect(), /Please wait/);
  socket.disconnect().connect();
  t.mock.timers.tick(100_000);
  assert.equal(socket.joins.length, 4);
  await assert.rejects(session.sync(), /Please retry/);
  const ready = session.reconnect();
  socket.emit("room-snapshot", snapshot);
  await ready;
  assert.equal(socket.joins.length, 5);
  assert.equal(session.isReady(), true);
});

test("join acknowledgement timeout is also bounded", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const socket = new FakeSocket();
  const errors: string[] = [];
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError: (message) => errors.push(message),
  }, 100);
  t.after(() => session.dispose());
  session.join(credentials);
  for (const delay of [1000, 2000, 4000]) {
    t.mock.timers.tick(100);
    t.mock.timers.tick(delay);
  }
  t.mock.timers.tick(100);
  assert.equal(socket.joins.length, 4);
  assert.deepEqual(errors, ["Server error"]);
});

test("new join and dispose cancel retries; terminal errors discard credentials", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const socket = new FakeSocket();
  const session = createRoomSession(socket as unknown as Socket, {
    onState() {}, onSnapshot() {}, onJoined() {}, onError() {},
  });
  session.join(credentials);
  socket.emit("join-error", "Server error");
  session.join({ ...credentials, roomId: "kite173" });
  socket.emit("room-snapshot", snapshot);
  t.mock.timers.tick(2000);
  assert.equal(socket.joins.length, 2);
  socket.emit("join-error", "Wrong password");
  await assert.rejects(session.sync(), /Join the room/);
  socket.disconnect().connect();
  assert.equal(socket.joins.length, 2);
  session.join(credentials);
  socket.emit("join-error", "Server error");
  session.dispose();
  t.mock.timers.tick(100_000);
  socket.disconnect().connect();
  assert.equal(socket.joins.length, 3);
});
