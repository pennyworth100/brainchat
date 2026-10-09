import { createHash } from "node:crypto";
import { ResumeUploadOperationGate, type OperationOutcome } from "./resume-operation";
import type { ResumeUploadGrant } from "./resume-upload-admission";

// SERVER-INTERNAL description only, never parsed from HTTP input. The future
// exclusive storage writer must compute size/digest from the settled byte stream.
// This shape is NOT a storage ownership capability or permission to unlink.
export type ResumeStoredFile = Readonly<{
  storageKey: string; name: string; size: number; mime: string; sha256: string;
}>;
export type ResumeFileMessage = {
  id: number; type: "file"; username: string; ts: number;
  url: string; name: string; size: number; mime: string;
};
export type ResumeFileWrite = { inserted: boolean; message: ResumeFileMessage };

export function canonicalResumeFile(file: ResumeStoredFile): ResumeStoredFile {
  if (!file || typeof file.storageKey !== "string" || file.storageKey.length !== 64 || !/^[a-f0-9]{64}$/.test(file.storageKey) ||
      typeof file.sha256 !== "string" || file.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.name !== "string" || !file.name.trim() || file.name.length > 255 ||
      /[\x00-\x1f\x7f/\\]/.test(file.name) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 100 * 1024 * 1024 ||
      typeof file.mime !== "string" || file.mime.length > 127 || file.mime.trim() !== file.mime ||
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(file.mime)) {
    throw Error("Invalid resume file metadata");
  }
  return Object.freeze({ storageKey: file.storageKey, name: file.name, size: file.size,
    mime: file.mime, sha256: file.sha256 });
}

type FileRow = { id: number; room_id: string; username: string; type: string; content: string; ts: Date };

// PRIVATE database-only primitive, not imported by public upload handlers.
// No filesystem effects, cleanup, retry, release, ACK or broadcast here.
export class ResumeFileWriter {
  constructor(private readonly gate: ResumeUploadOperationGate) {}

  saveOnceWithOutcome(grant: ResumeUploadGrant, clientMessageId: string,
    file: ResumeStoredFile): Promise<OperationOutcome<ResumeFileWrite>> {
    return this.gate.runWithOutcome(grant, async tx => {
      if (typeof clientMessageId !== "string" || clientMessageId.length < 1 ||
          clientMessageId.length > 128 || /[^A-Za-z0-9_-]/.test(clientMessageId)) {
        throw Error("Invalid resume file identity");
      }
      const candidate = canonicalResumeFile(file);
      const { binding } = grant;
      // Stable logical bytes/metadata identity, NOT this attempt's random path.
      const identity = (f: ResumeStoredFile) => JSON.stringify([
        binding.roomId, binding.username, "file", f.name, f.size, f.mime, f.sha256,
      ]);
      const hash = createHash("sha256").update(identity(candidate)).digest("hex");
      const content = (f: ResumeStoredFile) => JSON.stringify({
        url: `/uploads/${f.storageKey}/blob`, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256,
      });
      const receipt = (row: FileRow | undefined): ResumeFileMessage => {
        if (!row || !Number.isSafeInteger(row.id) || row.id < 1 ||
            row.room_id !== binding.roomId || row.username !== binding.username || row.type !== "file" ||
            typeof row.content !== "string" || row.content.length > 4096 ||
            !(row.ts instanceof Date) || !Number.isFinite(row.ts.getTime())) {
          throw Error("Resume file no longer available or invalid receipt");
        }
        const stored = JSON.parse(row.content);
        if (!stored || typeof stored.url !== "string" || !/^\/uploads\/[a-f0-9]{64}\/blob$/.test(stored.url)) {
          throw Error("Invalid resume file receipt URL");
        }
        const original = canonicalResumeFile({ ...stored, storageKey: stored.url.split("/")[2] });
        if (identity(original) !== identity(candidate) || row.content !== content(original)) {
          throw Error("Invalid resume file receipt content");
        }
        return { id: row.id, type: "file", username: row.username, ts: row.ts.getTime(),
          url: stored.url, name: original.name, size: original.size, mime: original.mime };
      };
      // Authorization precedes lookup. Same session/key namespace as text/image;
      // the gate's session lock serializes all three types across processes.
      const prior = await tx.query<FileRow & { payload_hash: string }>(`
        SELECT r.payload_hash, m.id, m.room_id, m.username, m.type, m.content, m.ts
        FROM resume_message_receipts r LEFT JOIN messages m ON m.id = r.message_id
        WHERE r.session_id = $1 AND r.client_message_id = $2`, [binding.sessionId, clientMessageId]);
      if (prior.rows.length) {
        if (prior.rows[0].payload_hash !== hash) throw Error("Resume message identity conflict");
        return { inserted: false, message: receipt(prior.rows[0]) };
      }
      const saved = await tx.query<FileRow>(`INSERT INTO messages
        (room_id, username, type, content, client_message_id, ts)
        VALUES ($1, $2, 'file', $3, NULL, clock_timestamp())
        RETURNING id, room_id, username, type, content, ts`, [binding.roomId, binding.username, content(candidate)]);
      const message = receipt(saved.rows[0]);
      // On an insert, only the current attempt's server-owned path is valid.
      if (message.url !== `/uploads/${candidate.storageKey}/blob`) throw Error("Invalid inserted file path");
      await tx.query(`INSERT INTO resume_message_receipts
        (session_id, client_message_id, payload_hash, message_id) VALUES ($1, $2, $3, $4)`,
        [binding.sessionId, clientMessageId, hash, message.id]);
      return { inserted: true, message };
    });
  }
}
