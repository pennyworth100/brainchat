import type { Pool } from "pg";
import { canonicalResumeFile, resumeFileContent, type ResumeStoredFile } from "./resume-file";

/** Trusted pool on the writer's database/schema, never its in-flight client.
 * Each lookup observes a fresh committed statement snapshot. No cache, receipt,
 * accounting charge, filesystem existence or transport ACK establishes visibility.
 * The caller owns the pool and retains this promise through server shutdown.
 */
export class ResumeFilePublication {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async publishedFile(storageKey: string): Promise<ResumeStoredFile | null> {
    if (typeof storageKey !== "string" || !/^[a-f0-9]{64}$/.test(storageKey)) return null;
    // Writer uses a canonical TEXT encoding. Do not cast arbitrary legacy TEXT
    // to JSON in SQL: malformed unrelated rows must not break valid downloads.
    const prefix = JSON.stringify({ url: `/uploads/${storageKey}/blob` }).slice(0, -1) + ",";
    const result = await this.pool.query<{ content: string }>(`
      SELECT content FROM messages
      WHERE type = 'file' AND left(content, $2) = $1
      LIMIT 2`, [prefix, prefix.length]);
    // Ambiguous paths fail closed; never choose one of conflicting publications.
    if (result.rows.length !== 1) return null;
    const content = result.rows[0].content;
    if (typeof content !== "string" || content.length > 4096) return null;
    try {
      const stored = JSON.parse(content);
      const file = canonicalResumeFile({ ...stored, storageKey });
      if (content !== resumeFileContent(file)) return null;
      return file;
    } catch { return null; }
  }
}
