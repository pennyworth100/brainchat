import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCreationToken,
  generateRoomId,
  hashCreationToken,
  hashPassword,
  isValidRoomId,
  normalizeRoomId,
  safeEqual,
  verifyPassword,
} from "./security";
import { ROOM_NOUNS } from "./room-words";

test("room noun dictionary is unique and phone-friendly", () => {
  assert.equal(new Set(ROOM_NOUNS).size, ROOM_NOUNS.length);
  for (const noun of ROOM_NOUNS) assert.match(noun, /^[a-z]{3,5}$/);
});

test("new room IDs use a short English noun and exactly three digits", () => {
  const ids = new Set(Array.from({ length: 200 }, () => generateRoomId()));
  assert.ok(ids.size > 180);
  for (const id of ids) {
    assert.match(id, /^[a-z]{3,5}\d{3}$/);
    assert.equal(ROOM_NOUNS.includes(id.slice(0, -3) as typeof ROOM_NOUNS[number]), true);
    assert.equal(isValidRoomId(id), true);
  }
});

test("readable IDs normalize case while previous formats remain valid", () => {
  assert.equal(isValidRoomId("APPLE482"), true);
  assert.equal(normalizeRoomId(" APPLE482 "), "apple482");
  assert.equal(isValidRoomId("2874"), true);
  assert.equal(isValidRoomId("AbCdEfGhIjKlMnOp"), true);
  assert.equal(isValidRoomId("123"), false);
  assert.equal(isValidRoomId("apple48"), false);
  assert.equal(isValidRoomId("planet482"), false);
  assert.equal(isValidRoomId("../../etc/passwd"), false);
});

test("creation tokens can be verified without storing the raw token", () => {
  const token = generateCreationToken();
  const digest = hashCreationToken(token);
  assert.equal(safeEqual(digest, hashCreationToken(token)), true);
  assert.equal(safeEqual(digest, hashCreationToken(generateCreationToken())), false);
});

test("passwords are stored as Argon2id hashes and verified", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(hash.includes("correct horse battery staple"), false);
  assert.equal(await verifyPassword(hash, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(hash, "wrong"), false);
});

test("legacy plaintext values are never accepted as password hashes", async () => {
  assert.equal(await verifyPassword("legacy-password", "legacy-password"), false);
});
