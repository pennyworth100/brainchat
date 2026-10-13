import test from "node:test";
import assert from "node:assert/strict";
import { isWriteCapacityError, writeCapacityReply } from "./write-capacity-error";

test("capacity classification handles pg and Drizzle causes without parsing leaked SQL", () => {
  assert.equal(isWriteCapacityError({ code: "53100" }), true);
  assert.equal(isWriteCapacityError(new Error("private SQL", { cause: { code: "53100" } })), true);
  for (const value of [null, "53100", { code: 53100 }, { code: "08006" }, new Error("53100")]) {
    assert.equal(isWriteCapacityError(value), false);
  }
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  assert.equal(isWriteCapacityError(cycle), false);
  let deep: unknown = { code: "53100" };
  for (let i = 0; i < 5; i++) deep = { cause: deep };
  assert.equal(isWriteCapacityError(deep), false);
  assert.equal(writeCapacityReply().outcome, "unknown");
  assert.equal(writeCapacityReply().autoRetry, false);
});
