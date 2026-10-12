import assert from "node:assert/strict";
import test from "node:test";
import { RoomActivityWriter } from "./room-activity";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test("a caller and settlement both wait for delayed activity SQL", async () => {
  const sql = deferred();
  const rooms: string[] = [];
  const writer = new RoomActivityWriter(room => { rooms.push(room); return sql.promise; });
  let returned = false, settled = false;
  const caller = writer.touch("room-one").then(() => { returned = true; });
  const drain = writer.settle().then(result => { settled = true; return result; });
  await turn();
  assert.deepEqual(rooms, ["room-one"]);
  assert.equal(returned, false);
  assert.equal(settled, false);
  sql.resolve();
  await caller;
  assert.deepEqual(await drain, { failedWrites: 0 });
});

test("settlement includes a second concurrent writer admitted while waiting", async () => {
  const first = deferred(), second = deferred();
  const writer = new RoomActivityWriter(room => room === "upload" ? first.promise : second.promise);
  const upload = writer.touch("upload");
  let settled = false;
  const drain = writer.settle().then(() => { settled = true; });
  await turn();
  const socket = writer.touch("socket");
  first.resolve();
  await upload;
  await turn();
  assert.equal(settled, false);
  second.resolve();
  await Promise.all([socket, drain]);
  assert.equal(settled, true);
});

test("SQL failure settles without invalidating a committed message; failure stays visible", async () => {
  const sql = deferred();
  const writer = new RoomActivityWriter(() => sql.promise);
  const committedMessage = { id: 42 };
  const request = (async () => { await writer.touch("room"); return committedMessage; })();
  const drain = writer.settle();
  sql.reject(new Error("connection lost"));
  assert.equal(await request, committedMessage);
  assert.deepEqual(await drain, { failedWrites: 1 });
  assert.deepEqual(await writer.settle(), { failedWrites: 1 });
});

test("synchronous update exceptions are best effort and reported", async () => {
  const writer = new RoomActivityWriter(() => { throw new Error("driver failure"); });
  await assert.doesNotReject(writer.touch("room"));
  assert.deepEqual(await writer.settle(), { failedWrites: 1 });
});

test("settlement is explicitly not an admission fence", async () => {
  let calls = 0;
  const writer = new RoomActivityWriter(async () => { calls++; });
  await writer.settle();
  await writer.touch("later");
  assert.equal(calls, 1);
  assert.deepEqual(await writer.settle(), { failedWrites: 0 });
});
