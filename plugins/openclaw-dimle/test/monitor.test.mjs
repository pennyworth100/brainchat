import assert from "node:assert/strict";
import test from "node:test";
import { pollRoomOnce } from "../src/monitor.js";

function memoryCursor(initial = null) {
  let cursor = initial;
  return { get: async () => cursor, set: async (_room, value) => { cursor = value; } };
}

test("first start establishes a high-water mark without replaying old room history", async () => {
  const cursorStore = memoryCursor();
  const dispatched = [];
  const result = await pollRoomOnce({
    roomId: "spoon651",
    ownUsername: "Alfred",
    client: { getMessages: async () => [{ id: 10, username: "Max", message: "old" }] },
    cursorStore,
    dispatch: async (event) => dispatched.push(event),
  });
  assert.equal(result.cursor, 10);
  assert.deepEqual(dispatched, []);
});

test("cursor advances only after dispatch and suppresses self messages", async () => {
  const cursorStore = memoryCursor(10);
  const dispatched = [];
  const client = { getMessages: async () => [
    { id: 11, username: "Alfred", message: "self" },
    { id: 12, username: "Max", message: "new" },
  ] };
  const first = await pollRoomOnce({ roomId: "spoon651", ownUsername: "Alfred", client, cursorStore, dispatch: async (event) => dispatched.push(event) });
  assert.equal(first.cursor, 12);
  assert.deepEqual(dispatched.map((event) => event.id), [12]);
  await pollRoomOnce({ roomId: "spoon651", ownUsername: "Alfred", client, cursorStore, dispatch: async (event) => dispatched.push(event) });
  assert.deepEqual(dispatched.map((event) => event.id), [12]);
});

test("failed dispatch is retried because its cursor is not committed", async () => {
  const cursorStore = memoryCursor(20);
  const client = { getMessages: async () => [{ id: 21, username: "Max", message: "retry me" }] };
  await assert.rejects(
    pollRoomOnce({ roomId: "spoon651", ownUsername: "Alfred", client, cursorStore, dispatch: async () => { throw new Error("offline"); } }),
    /offline/
  );
  let attempts = 0;
  const result = await pollRoomOnce({ roomId: "spoon651", ownUsername: "Alfred", client, cursorStore, dispatch: async () => { attempts += 1; } });
  assert.equal(attempts, 1);
  assert.equal(result.cursor, 21);
});
