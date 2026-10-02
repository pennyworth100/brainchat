import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCreationToken,
  generateRoomId,
  hashCreationToken,
  hashPassword,
  isValidRoomId,
  safeEqual,
  verifyPassword,
} from "./security";

test("new room IDs are cryptographically random and valid", () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateRoomId()));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.equal(isValidRoomId(id), true);
});

test("legacy room IDs remain valid but malformed IDs are rejected", () => {
  assert.equal(isValidRoomId("2874"), true);
  assert.equal(isValidRoomId("123"), false);
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
