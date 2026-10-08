import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { hashResumeToken, ResumeStore } from "./resume-store";

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
