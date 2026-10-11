import type { Pool, PoolClient } from "pg";

type Database = Pick<Pool | PoolClient, "query">;
type ClaimedPolicy = {
  id: string; passwordHash: string | null; creationTokenHash: null; authVersion: number;
};

// Hash/verify the creation token and password BEFORE calling this short CAS.
// Every future password/policy mutation must likewise bump auth_version in the
// same write. Integer overflow fails the statement closed, never wraps.
export async function claimRoomPolicy(database: Database, roomId: string,
  expectedTokenHash: string, passwordHash: string | null): Promise<ClaimedPolicy | null> {
  if (!expectedTokenHash) return null;
  const result = await database.query<ClaimedPolicy>(`
    UPDATE rooms SET password_hash = $3, creation_token_hash = NULL,
      auth_version = auth_version + 1
    WHERE id = $1 AND creation_token_hash = $2
    RETURNING id, password_hash AS "passwordHash",
      creation_token_hash AS "creationTokenHash", auth_version AS "authVersion"
  `, [roomId, expectedTokenHash, passwordHash]);
  return result.rows[0] ?? null;
}
