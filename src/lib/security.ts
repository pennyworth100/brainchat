import crypto from "crypto";
import argon2 from "argon2";
import { isValidRoomId } from "./room-id";

export { isValidRoomId } from "./room-id";

export function generateRoomId() {
  return crypto.randomBytes(12).toString("base64url");
}

export function generateCreationToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashCreationToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export async function hashPassword(password: string) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string) {
  if (!hash.startsWith("$argon2id$")) return false;

  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
