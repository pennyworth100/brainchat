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

  // Internal, explicitly invoked maintenance only; no live scheduler yet.
  // Bound session rows, not cascade cost: receipt volume still needs operational
  // budgeting before rollout. Never prune receipts of a still-live session.
  // Lock only sessions (no reverse room-lock order); busy sessions are skipped.
  async cleanupExpired(batchSize = 100): Promise<number> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("Invalid resume cleanup batch size");
    }
    const result = await this.database.query(`
      WITH expired AS MATERIALIZED (
        SELECT id FROM room_resume_sessions
        WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at, id
        LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM room_resume_sessions s USING expired e
      WHERE s.id = e.id AND s.expires_at <= clock_timestamp()
    `, [batchSize]);
    return result.rowCount ?? 0;
  }

  // Caller must authenticate a normal join first and pass the authVersion
  // observed during that authentication. Never accept it from a client.
  // SHARE serializes issuance with policy updates; READ COMMITTED rechecks the
  // version after a wait. An unclaimed room cannot issue credentials. Success
  // is only a credential, not admission: CAS/binding must still authorize it.
  async issueAfterAuthenticatedJoin(roomId: string, username: string, authVersion: number) {
    if (typeof roomId !== "string" || !isValidRoomId(roomId) || typeof username !== "string" ||
        !username.trim() || username.length > 64 ||
        !Number.isSafeInteger(authVersion) || authVersion < 1) throw new Error("Invalid authenticated join");
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const result = await this.database.query<ResumeIdentity>(`
      WITH authorized_room AS MATERIALIZED (
        SELECT id, auth_version FROM rooms
        WHERE id = $3 AND auth_version = $5 AND creation_token_hash IS NULL
        FOR SHARE
      )
      INSERT INTO room_resume_sessions
        (id, token_hash, room_id, username, auth_version, issued_at, expires_at)
      SELECT $1, $2, id, $4, auth_version, statement_timestamp(),
             statement_timestamp() + interval '24 hours'
      FROM authorized_room
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

  // Persistence CAS only; this does NOT install membership or evict a socket.
  // transportId must be a server-owned, globally unique connection incarnation,
  // never a client-provided value. ACK retry is valid only on that same transport.
  // After transport loss, lookup recovers generation without granting membership;
  // a fresh operation is needed. A CAS loser must not automatically steal it back.
  async advanceGeneration(credential: ResumeCredential, expectedGeneration: number,
    operationId: string, transportId: string): Promise<ResumeIdentity | null> {
    if (!validCredential(credential) || !Number.isInteger(expectedGeneration) ||
        expectedGeneration < 0 || expectedGeneration >= 2_147_483_647 ||
        typeof operationId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId) ||
        typeof transportId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(transportId)) return null;
    const tokenHash = hashResumeToken(credential.token);
    if (!tokenHash) return null;
    // Room share lock serializes with policy changes/deletion. UPDATE rechecks
    // the session predicate after any competing updater commits (READ COMMITTED).
    // Only one bounded operation receipt per session, expiring with the session.
    const result = await this.database.query<ResumeIdentity>(`
      WITH authorized_room AS MATERIALIZED (
        SELECT id, auth_version FROM rooms WHERE id = $3 FOR SHARE
      )
      UPDATE room_resume_sessions s
      SET generation = CASE WHEN s.generation = $4 THEN s.generation + 1 ELSE s.generation END,
          last_operation_id = $5, last_transport_id = $6
      FROM authorized_room r
      WHERE s.id = $1 AND s.token_hash = $2 AND s.room_id = r.id
        AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        AND s.auth_version = r.auth_version
        AND ((s.generation = $4 AND s.last_operation_id IS DISTINCT FROM $5)
          OR (s.generation = $4 + 1 AND s.last_operation_id = $5 AND s.last_transport_id = $6))
      RETURNING s.id AS "sessionId", s.room_id AS "roomId", s.username,
        s.auth_version AS "authVersion", s.generation,
        s.issued_at AS "issuedAt", s.expires_at AS "expiresAt"
    `, [credential.sessionId, tokenHash, credential.roomId, expectedGeneration, operationId, transportId]);
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
