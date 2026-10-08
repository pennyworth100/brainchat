import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hashResumeToken, ResumeStore } from "./resume-store";
import { claimRoomPolicy } from "./room-policy";

test("issuance preserves the existing 64-character username boundary", async () => {
  let calls = 0;
  const store = new ResumeStore({ query: async () => { calls++; return { rowCount: 0, rows: [] }; } } as never);
  assert.equal(await store.issueAfterAuthenticatedJoin("candy986", "x".repeat(64), 1), null);
  for (const name of ["", "   ", "x".repeat(65)]) {
    await assert.rejects(store.issueAfterAuthenticatedJoin("candy986", name, 1), /Invalid authenticated join/);
  }
  assert.equal(calls, 1);
});

test("claim fails closed for absent token and database errors", async () => {
  let calls = 0;
  const database = { query: async () => { calls++; throw new Error("offline"); } } as never;
  assert.equal(await claimRoomPolicy(database, "candy986", "", null), null);
  assert.equal(calls, 0);
  await assert.rejects(claimRoomPolicy(database, "candy986", "verified-hash", null), /offline/);
  assert.equal(calls, 1);
});

test("resume token parser rejects malformed and noncanonical bearer values", () => {
  for (const value of [null, undefined, {}, 42, "", "a".repeat(42), "a".repeat(44), "!".repeat(43), "_".repeat(43)]) {
    assert.equal(hashResumeToken(value), null);
  }
  const token = randomBytes(32).toString("base64url");
  assert.match(hashResumeToken(token)!, /^[0-9a-f]{64}$/);
  assert.equal(hashResumeToken(token), hashResumeToken(token));
  assert.notEqual(hashResumeToken(token), hashResumeToken(randomBytes(32).toString("base64url")));
});

test("invalid credentials never reach persistence; DB failure never authorizes", async () => {
  let calls = 0;
  const store = new ResumeStore({ query: async () => { calls++; throw new Error("offline"); } } as never);
  const valid = { roomId: "candy986", sessionId: "b4b7467b-978a-4323-b151-0de94c57d598", token: randomBytes(32).toString("base64url") };
  assert.equal(await store.lookup({ ...valid, roomId: "wrong" }), null);
  assert.equal(await store.lookup({ ...valid, sessionId: "not-a-session" }), null);
  assert.equal(await store.lookup({ ...valid, token: "bad" }), null);
  assert.equal(await store.revoke(valid, -1), false);
  assert.equal(calls, 0);
  await assert.rejects(store.lookup(valid), /offline/);
  await assert.rejects(store.issueAfterAuthenticatedJoin("candy986", "Alfred", 1), /offline/);
  assert.equal(calls, 2);
});

test("generation CAS rejects invalid inputs before DB and propagates DB failure", async () => {
  let calls = 0;
  const store = new ResumeStore({ query: async () => { calls++; throw new Error("offline"); } } as never);
  const credential = { roomId: "candy986", sessionId: "b4b7467b-978a-4323-b151-0de94c57d598", token: randomBytes(32).toString("base64url") };
  for (const generation of [-1, 0.5, NaN, Infinity, 2_147_483_647]) {
    assert.equal(await store.advanceGeneration(credential, generation, "operation_123456", "transport_123456"), null);
  }
  assert.equal(await store.advanceGeneration(credential, 0, "short", "transport_123456"), null);
  assert.equal(await store.advanceGeneration(credential, 0, "operation_123456", ""), null);
  assert.equal(await store.advanceGeneration({ ...credential, token: "bad" }, 0, "operation_123456", "transport_123456"), null);
  assert.equal(calls, 0);
  await assert.rejects(store.advanceGeneration(credential, 0, "operation_1234567", "transport_1234567"), /offline/);
  assert.equal(calls, 1);
});
