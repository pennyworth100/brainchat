import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isValidRoomId } from "./room-id";

// Server-only persistence foundation. No socket handler uses this yet.
// A successful lookup is NOT membership or authority to send/leave a room.
type Database = Pick<Pool | PoolClient, "query">;
export type ResumeCredential = { roomId: string; sessionId: string; token: string };
export type ResumeIdentity = {
  sessionId: string; roomId: string; username: string; authVersion: number;
  generation: number; issuedAt: Date; expiresAt: Date;
};

export function hashResumeToken(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) return null;
  return createHash("sha256").update(bytes).digest("hex");
}

function validCredential(value: ResumeCredential) {
  return value && typeof value.roomId === "string" && isValidRoomId(value.roomId) &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.sessionId);
}

export class ResumeStore {
  constructor(private readonly database: Database) {}

  // Caller must authenticate a normal join first and pass the authVersion
  // observed during that authentication. Never accept it from a client.
  async issueAfterAuthenticatedJoin(roomId: string, username: string, authVersion: number) {
    if (typeof roomId !== "string" || !isValidRoomId(roomId) || typeof username !== "string" ||
        !username.trim() || username.length > 32 ||
        !Number.isSafeInteger(authVersion) || authVersion < 1) throw new Error("Invalid authenticated join");
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const result = await this.database.query<ResumeIdentity>(`
      INSERT INTO room_resume_sessions
        (id, token_hash, room_id, username, auth_version, issued_at, expires_at)
      SELECT $1, $2, id, $4, auth_version, statement_timestamp(),
             statement_timestamp() + interval '24 hours'
      FROM rooms WHERE id = $3 AND auth_version = $5
      RETURNING id AS "sessionId", room_id AS "roomId", username,
        auth_version AS "authVersion", generation, issued_at AS "issuedAt", expires_at AS "expiresAt"
    `, [sessionId, hashResumeToken(token), roomId, username, authVersion]);
    if (result.rowCount !== 1) return null;
    return { ...result.rows[0], token };
  }

  // Non-mutating lookup; expiry uses DB time and is never extended by reads.
  // DB errors propagate: the transport layer must fail closed, not fall back.
  async lookup(credential: ResumeCredential): Promise<ResumeIdentity | null> {
    if (!validCredential(credential)) return null;
    const tokenHash = hashResumeToken(credential.token);
    if (!tokenHash) return null;
    const result = await this.database.query<ResumeIdentity>(`
      SELECT s.id AS "sessionId", s.room_id AS "roomId", s.username,
        s.auth_version AS "authVersion", s.generation,
        s.issued_at AS "issuedAt", s.expires_at AS "expiresAt"
      FROM room_resume_sessions s JOIN rooms r ON r.id = s.room_id
      WHERE s.id = $1 AND s.token_hash = $2 AND s.room_id = $3
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
        AND s.auth_version = r.auth_version
    `, [credential.sessionId, tokenHash, credential.roomId]);
    return result.rows[0] ?? null;
  }

  // Future leave handler must additionally check the current socket binding.
  // Generation predicate prevents a stale generation from revoking its successor.
  async revoke(credential: ResumeCredential, generation: number): Promise<boolean> {
    if (!validCredential(credential) || !Number.isSafeInteger(generation) || generation < 0) return false;
    const tokenHash = hashResumeToken(credential.token);
    if (!tokenHash) return false;
    const result = await this.database.query(`
      UPDATE room_resume_sessions SET revoked_at = statement_timestamp()
      WHERE id = $1 AND token_hash = $2 AND room_id = $3 AND generation = $4
        AND revoked_at IS NULL
    `, [credential.sessionId, tokenHash, credential.roomId, generation]);
    return result.rowCount === 1;
  }
}
