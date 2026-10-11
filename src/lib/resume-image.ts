import { createHash } from "node:crypto";
import type { ResumeBinding } from "./resume-bindings";
import { ResumeOperationGate, type OperationResult } from "./resume-operation";

export const MAX_RESUME_IMAGE_DATA_URL_LENGTH = 12 * 1024 * 1024;
export type ResumeImageMessage = {
  id: number; type: "image"; username: string; dataUrl: string; ts: number;
};
export type ResumeImageWrite = { message: ResumeImageMessage; inserted: boolean };

// Bounded, canonical inline payload only. No URL fetch, path, filesystem write,
// or image decoding. MIME is an allowlist, NOT proof of decoded image safety.
export function canonicalResumeImage(dataUrl: unknown): string {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_RESUME_IMAGE_DATA_URL_LENGTH) {
    throw new Error("Invalid resume image");
  }
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma).toLowerCase();
  if (!/^data:image\/(?:png|jpeg|gif|webp);base64$/.test(header)) {
    throw new Error("Invalid resume image");
  }
  const encoded = dataUrl.slice(comma + 1);
  // Buffer's decoder alone is permissive (ignores whitespace/invalid bytes).
  // Roundtrip also rejects nonzero padding bits and noncanonical padding.
  if (!encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) ||
      Buffer.from(encoded, "base64").toString("base64") !== encoded) {
    throw new Error("Invalid resume image");
  }
  return header + "," + encoded;
}

type ImageRow = { id: number; room_id: string; username: string; type: string; content: string; ts: Date };

// Public normal-join handler composes admission, quotas, deadline/capacity and
// exact outbound fencing. A persisted receipt is NOT delivery authority.
export class ResumeImageWriter {
  constructor(private readonly gate: ResumeOperationGate) {}

  saveOnceWithOutcome(binding: ResumeBinding, clientMessageId: string,
    dataUrl: string): Promise<OperationResult<ResumeImageWrite>> {
    return this.gate.run(binding, async tx => {
      if (typeof clientMessageId !== "string" || clientMessageId.length < 1 ||
          clientMessageId.length > 128 || /[^A-Za-z0-9_-]/.test(clientMessageId)) {
        throw new Error("Invalid resume image identity");
      }
      const canonical = canonicalResumeImage(dataUrl);
      const content = JSON.stringify({ dataUrl: canonical });
      const hash = createHash("sha256").update(JSON.stringify([
        binding.roomId, binding.username, "image", canonical,
      ])).digest("hex");
      const receipt = (row: ImageRow | undefined): ResumeImageMessage => {
        if (!row || !Number.isSafeInteger(row.id) || row.id < 1 ||
            row.room_id !== binding.roomId || row.username !== binding.username ||
            row.type !== "image" || row.content !== content ||
            !(row.ts instanceof Date) || !Number.isFinite(row.ts.getTime())) {
          throw new Error("Resume image no longer available or invalid receipt");
        }
        return { id: row.id, type: "image", username: row.username,
          dataUrl: canonical, ts: row.ts.getTime() };
      };
      // SAME session/key namespace as text. Gate holds the session row lock;
      // concurrent text/image attempts cannot both insert for the same key.
      const prior = await tx.query<ImageRow & { payload_hash: string }>(`
        SELECT r.payload_hash, m.id, m.room_id, m.username, m.type, m.content, m.ts
        FROM resume_message_receipts r LEFT JOIN messages m ON m.id = r.message_id
        WHERE r.session_id = $1 AND r.client_message_id = $2`, [binding.sessionId, clientMessageId]);
      if (prior.rows.length) {
        if (prior.rows[0].payload_hash !== hash) throw new Error("Resume message identity conflict");
        return { inserted: false, message: receipt(prior.rows[0]) };
      }
      const saved = await tx.query<ImageRow>(`INSERT INTO messages
        (room_id, username, type, content, client_message_id, ts)
        VALUES ($1, $2, 'image', $3, NULL, clock_timestamp())
        RETURNING id, room_id, username, type, content, ts`, [binding.roomId, binding.username, content]);
      const message = receipt(saved.rows[0]);
      await tx.query(`INSERT INTO resume_message_receipts
        (session_id, client_message_id, payload_hash, message_id) VALUES ($1, $2, $3, $4)`,
        [binding.sessionId, clientMessageId, hash, message.id]);
      return { inserted: true, message };
    });
  }
}
