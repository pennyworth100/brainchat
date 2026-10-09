import type { QueryResult } from "pg";
import { canonicalResumeFile } from "./resume-file";

export type ReferenceObservation = {
  messageId: number | null; roomId: string | null;
  sessionId?: string; clientMessageId?: string;
  status: "tombstone" | "non-file" | "oversized" | "invalid" | "reference";
  storageKey: string | null;
  metadataStatus: "valid" | "invalid" | "unobserved" | "not-applicable";
  // Declared values, NOT measured filesystem integrity.
  declaredSize?: number; declaredSha256?: string;
};
export type ReferenceInventory = {
  receipts: ReferenceObservation[]; messages: ReferenceObservation[];
  complete: boolean; parseComplete: boolean; metadataComplete: boolean; reasons: string[];
};
type Query = (text: string, values?: unknown[]) => Promise<QueryResult>;

// PRIVATE transaction participant: never begins/resets/releases a connection.
// The outer exclusive owner supplies a fresh pinned read-only transaction and
// one shared deadline. No raw message content leaves this module.
export async function collectUploadReferences(query: Query,
  limits: { pageSize: number; maxRows: number }, report: ReferenceInventory): Promise<void> {
  let parseValid = true, metadataValid = true;
  const projection = `m.id AS message_id, left(m.room_id,128) AS room_id,
    left(m.type,16) AS type,
    CASE WHEN octet_length(m.content)<=4096 THEN m.content ELSE NULL END AS content,
    (octet_length(m.content)>4096 OR length(m.room_id)>128 OR length(m.type)>16) AS oversized`;
  for (const source of ["receipts", "messages"] as const) {
    const sql = source === "receipts"
      ? `SELECT left(r.session_id,128) AS session_id, left(r.client_message_id,128) AS client_message_id,
          (length(r.session_id)>128 OR length(r.client_message_id)>128) AS receipt_oversized,
          ${projection} FROM resume_message_receipts r LEFT JOIN messages m ON m.id=r.message_id
          ORDER BY r.session_id,r.client_message_id`
      : `SELECT ${projection} FROM messages m WHERE m.type='file' ORDER BY m.id`;
    await query(`DECLARE reference_${source} NO SCROLL CURSOR FOR ${sql}`);
    while (true) {
      const count = Math.min(limits.pageSize, limits.maxRows - report[source].length + 1);
      const rows = (await query(`FETCH FORWARD ${count} FROM reference_${source}`)).rows;
      for (const row of rows) {
        if (report[source].length === limits.maxRows) {
          report.reasons.push("row-limit:" + source); return;
        }
        const observation: ReferenceObservation = {
          messageId: row.message_id, roomId: row.room_id, storageKey: null, status: "invalid",
          metadataStatus: "unobserved",
          ...(source === "receipts" ? { sessionId: row.session_id, clientMessageId: row.client_message_id } : {}),
        };
        if (row.oversized || row.receipt_oversized) observation.status = "oversized";
        else if (row.message_id === null) { observation.status = "tombstone"; observation.metadataStatus = "not-applicable"; }
        else if (row.type !== "file") { observation.status = "non-file"; observation.metadataStatus = "not-applicable"; }
        // Oversized provenance must NOT erase a positive bounded URL reference.
        // Oversized bodies remain unread, even if a test/driver violates SQL's cap.
        if (row.type === "file" && typeof row.content === "string" && Buffer.byteLength(row.content, "utf8") <= 4096) {
          observation.metadataStatus = "invalid";
          try {
            const metadata = JSON.parse(row.content);
            const match = typeof metadata?.url === "string" && /^\/uploads\/([a-f0-9]{64})\/blob$/.exec(metadata.url);
            if (match && metadata.url === `/uploads/${match[1]}/blob`) {
              observation.storageKey = match[1];
              if (observation.status !== "oversized") observation.status = "reference";
              observation.metadataStatus = "invalid";
              const file = canonicalResumeFile({ ...metadata, storageKey: match[1] });
              // Match the writer's serialization: reject extra fields, duplicate
              // JSON keys, alternate ordering/whitespace and noncanonical numbers.
              const canonical = JSON.stringify({ url: `/uploads/${match[1]}/blob`, name: file.name,
                size: file.size, mime: file.mime, sha256: file.sha256 });
              if (row.content === canonical) {
                observation.metadataStatus = "valid";
                observation.declaredSize = file.size; observation.declaredSha256 = file.sha256;
              }
            } else observation.metadataStatus = "invalid";
          } catch { /* malformed content is explicit, never echoed */ }
        }
        if (observation.status === "invalid" || observation.status === "oversized") parseValid = false;
        if (observation.metadataStatus === "invalid" || observation.metadataStatus === "unobserved") metadataValid = false;
        // Preserve every positive reference; not an ownership or validity claim.
        report[source].push(observation);
      }
      if (rows.length < count) break;
    }
  }
  report.complete = true;
  report.parseComplete = parseValid;
  report.metadataComplete = metadataValid;
}
