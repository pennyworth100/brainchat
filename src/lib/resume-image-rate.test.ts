import assert from "node:assert/strict";
import test from "node:test";
import { ResumeImageRate, consumeResumeImageAttempt } from "./resume-image-rate";
import { MAX_RESUME_IMAGE_DATA_URL_LENGTH } from "./resume-image";

test("image byte budget is inclusive; byte denials cost attempts but not unadmitted bytes", () => {
  const rate = new ResumeImageRate(3, 10, 60, 2, () => 0);
  assert.equal(rate.consume("a", 11), false);
  assert.equal(rate.consume("a", 6), true);
  assert.equal(rate.consume("a", 4), true);
  assert.equal(rate.consume("a", 1), false);
  assert.equal(rate.consume("b", 10), true);
  assert.equal(rate.consume("b", 1), false);
  const denied = new ResumeImageRate(2, 10, 60, 1, () => 0);
  assert.equal(denied.consume("a", 11), false);
  assert.equal(denied.consume("a", 11), false);
  assert.equal(denied.consume("a", 1), false);
});

test("image attempts independently cap tiny retries; fixed-window expiry is exact", () => {
  let now = 100;
  const rate = new ResumeImageRate(2, 1000, 60, 2, () => now);
  assert.equal(rate.consume("durable-session", 1), true);
  now = 159; assert.equal(rate.consume("durable-session", 1), true);
  assert.equal(rate.consume("durable-session", 1), false);
  now = 160; assert.equal(rate.consume("durable-session", 1000), true);
  assert.equal(rate.consume("durable-session", 1), false);
});

test("image capacity never evicts live debt; old windows expire in insertion order", () => {
  let now = 0;
  const rate = new ResumeImageRate(3, 2, 10, 2, () => now);
  assert.equal(rate.consume("a", 2), true);
  now = 5; assert.equal(rate.consume("b", 2), true);
  for (let i = 0; i < 100; i++) assert.equal(rate.consume(`new-${i}`, 1), false);
  assert.equal(rate.consume("a", 1), false);
  now = 10; assert.equal(rate.consume("c", 2), true);
  assert.equal(rate.consume("b", 1), false);
  assert.equal(rate.consume("d", 1), false);
  now = 15; assert.equal(rate.consume("d", 1), true);
  assert.equal(rate.consume("c", 1), false);
});

test("image invalid clocks and backwards movement cannot reset debt", () => {
  let now = 0;
  const rate = new ResumeImageRate(1, 10, 10, 2, () => now);
  assert.equal(rate.consume("a", 10), true);
  now = -100; assert.equal(rate.consume("a", 1), false);
  now = NaN; assert.equal(rate.consume("b", 1), false);
  now = Infinity; assert.equal(rate.consume("b", 1), false);
  now = 0; assert.equal(rate.consume("b", 10), true);
  now = 10; assert.equal(rate.consume("a", 10), true);
});

test("invalid image policy, identity and byte counts fail closed without occupying capacity", () => {
  for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ResumeImageRate(bad), /Invalid image rate policy/);
    assert.throws(() => new ResumeImageRate(1, bad), /Invalid image rate policy/);
    assert.throws(() => new ResumeImageRate(1, 1, bad), /Invalid image rate policy/);
    assert.throws(() => new ResumeImageRate(1, 1, 1, bad), /Invalid image rate policy/);
  }
  const rate = new ResumeImageRate(1, 10, 60, 1, () => 0);
  for (const key of ["", "bad key", "a".repeat(129)]) assert.equal(rate.consume(key, 1), false);
  for (const bad of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(rate.consume("valid", bad), false);
  }
  assert.equal(rate.consume("valid", 10), true);
});

test("image admission bounds before byte scan and shares nonrefundable session attempt debt", () => {
  const session = "image-bounds-test";
  const tooLong = "a".repeat(MAX_RESUME_IMAGE_DATA_URL_LENGTH + 1);
  for (const payload of [null, {}, 1, "", tooLong]) {
    assert.equal(consumeResumeImageAttempt(session, payload), false);
  }
  // Bounded malformed payloads cost attempts; the later writer must reject them.
  for (let i = 0; i < 12; i++) assert.equal(consumeResumeImageAttempt(session, "invalid"), true);
  assert.equal(consumeResumeImageAttempt(session, "invalid"), false);
});

test("image admission charges UTF8 including header and enforces exact maximum input size", () => {
  const header = "data:image/png;base64,";
  const maximum = header + "a".repeat(MAX_RESUME_IMAGE_DATA_URL_LENGTH - header.length);
  for (let i = 0; i < 4; i++) assert.equal(consumeResumeImageAttempt("ascii-byte-test", maximum), true);
  assert.equal(consumeResumeImageAttempt("ascii-byte-test", "a"), false);
  // Same code-unit length, three times the UTF8 cost; not accepted as an image.
  const unicode = "\u20ac".repeat(MAX_RESUME_IMAGE_DATA_URL_LENGTH);
  assert.equal(consumeResumeImageAttempt("unicode-byte-test", unicode), true);
  assert.equal(consumeResumeImageAttempt("unicode-byte-test", unicode), false);
  assert.equal(consumeResumeImageAttempt("unicode-byte-test", maximum), true);
  assert.equal(consumeResumeImageAttempt("unicode-byte-test", "a"), false);
});
