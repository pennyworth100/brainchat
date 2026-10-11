import assert from "node:assert/strict";
import test from "node:test";
import { ResumeTextRate } from "./resume-text-rate";

test("rate windows retain debt through retries, reject excess, and expire at exact boundary", () => {
  let now = 100;
  const rate = new ResumeTextRate(2, 60, 2, () => now);
  assert.equal(rate.consume("session-a"), true);
  now = 159; assert.equal(rate.consume("session-a"), true);
  assert.equal(rate.consume("session-a"), false);
  assert.equal(rate.consume("session-b"), true);
  now = 160; assert.equal(rate.consume("session-a"), true);
  assert.equal(rate.consume("session-a"), true);
  assert.equal(rate.consume("session-a"), false);
  assert.equal(rate.consume("session-b"), true);
  assert.equal(rate.consume("session-b"), false);
});

test("full rate state rejects new identities without evicting live debt; expiry recovers slots", () => {
  let now = 0;
  const rate = new ResumeTextRate(1, 10, 2, () => now);
  assert.equal(rate.consume("a"), true);
  now = 5; assert.equal(rate.consume("b"), true);
  for (let i = 0; i < 100; i++) assert.equal(rate.consume(`new-${i}`), false);
  assert.equal(rate.consume("a"), false);
  now = 10; assert.equal(rate.consume("c"), true);
  assert.equal(rate.consume("b"), false);
  assert.equal(rate.consume("d"), false);
  now = 15; assert.equal(rate.consume("d"), true);
  assert.equal(rate.consume("c"), false);
});

test("rate clock regressions and invalid observations cannot erase or add debt", () => {
  let now = 0;
  const rate = new ResumeTextRate(1, 10, 2, () => now);
  assert.equal(rate.consume("a"), true);
  now = -100; assert.equal(rate.consume("a"), false);
  now = NaN; assert.equal(rate.consume("b"), false);
  now = Infinity; assert.equal(rate.consume("b"), false);
  now = 0; assert.equal(rate.consume("b"), true);
  now = 10; assert.equal(rate.consume("a"), true);
});

test("invalid policy and identities fail closed without occupying state", () => {
  for (const bad of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => new ResumeTextRate(bad), /Invalid text rate policy/);
    assert.throws(() => new ResumeTextRate(1, bad), /Invalid text rate policy/);
    assert.throws(() => new ResumeTextRate(1, 1, bad), /Invalid text rate policy/);
  }
  const rate = new ResumeTextRate(1, 10, 1, () => 0);
  for (const key of ["", "bad key", "a".repeat(129)]) assert.equal(rate.consume(key), false);
  assert.equal(rate.consume("valid"), true);
});
