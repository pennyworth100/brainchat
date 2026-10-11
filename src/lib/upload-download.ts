import express from "express";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { canonicalResumeFile, type ResumeStoredFile } from "./resume-file";
import { openStrictUploadRoot, strictUploadRootPath, type StrictUploadRootBinding } from "./upload-storage-root";
import type { StrictUploadResourcePolicyPin } from "./upload-resource-policy-pin";

export type StrictDownloadSource = Readonly<{
  root: StrictUploadRootBinding;
  pin: StrictUploadResourcePolicyPin;
  limit: number;
  // TRUSTED server lookup of a committed, visible message, not HTTP metadata,
  // directory existence, an accounting charge or a pending/unknown write.
  publishedFile(storageKey: string): Promise<ResumeStoredFile | null>;
}>;

/** Read-only mapping. Provisioning still requires stable exclusive ancestors,
 * no hostile same-uid mutation and immutable published blobs (as the writer).
 * No mkdir, delete, recovery, physical capacity authority or environment switch.
 * A null source must remain installed until trusted provisioning is complete.
 */
export function createUploadDownloadRouter(legacyRoot: string, source: StrictDownloadSource | null) {
  const router = express.Router();
  const strict = source && Object.freeze({ root: source.root, pin: source.pin,
    limit: source.limit, publishedFile: source.publishedFile.bind(source) });
  router.use(async (req, res, next) => {
    let rel: string;
    try { rel = decodeURIComponent(req.path); }
    catch { res.status(400).end(); return; }
    if (rel.split(/[\\/]/).includes("..")) { res.status(403).end(); return; }
    const parts = rel.split("/");
    const key = parts[1];
    if (parts.length !== 3 || !key || /[^a-f0-9]/.test(key)) {
      res.status(404).end(); return;
    }
    if (key.length === 16) {
      // Legacy writer has always used 8 random bytes and one sanitized filename.
      // Never expose a backup/root parent, nested namespace or directory index.
      const name = parts[2];
      if (!name || name === "." || name.length > 128 || /[^\w.\- ]/.test(name)) {
        res.status(404).end(); return;
      }
      next(); return;
    }
    if (key.length !== 64 || parts[2] !== "blob") { res.status(404).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD"); res.status(405).end(); return;
    }
    if (!strict) { res.status(503).end(); return; }
    let root: FileHandle | undefined, directory: FileHandle | undefined, file: FileHandle | undefined;
    try {
      // Validate the opaque binding before even calling the publication lookup.
      const rootPath = strictUploadRootPath(strict.root, strict.pin, strict.limit);
      if (!rootPath) throw Error("Download root denied");
      root = await openStrictUploadRoot(strict.root, strict.pin, strict.limit);
      const published = await strict.publishedFile(key);
      if (!published) throw Error("Unpublished download");
      const metadata = canonicalResumeFile(published);
      if (metadata.storageKey !== key || metadata.size > strict.limit) throw Error("Download identity denied");
      directory = await open(join(rootPath, key), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parent = await root.stat({ bigint: true });
      const dir = await directory.stat({ bigint: true });
      if (!dir.isDirectory() || dir.dev !== parent.dev || dir.uid !== parent.uid ||
          dir.gid !== parent.gid || (dir.mode & 0o7777n) !== 0o700n) throw Error("Download directory denied");
      // NONBLOCK prevents a corrupt FIFO from hanging the HTTP lifetime.
      file = await open(join(rootPath, key, "blob"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await file.stat({ bigint: true });
      if (!st.isFile() || st.dev !== parent.dev || st.uid !== parent.uid || st.gid !== parent.gid ||
          st.nlink !== 1n || (st.mode & 0o7777n) !== 0o600n || st.size !== BigInt(metadata.size)) {
        throw Error("Download file denied");
      }
      // Recheck expected root identity after asynchronous publication lookup.
      const checked = await openStrictUploadRoot(strict.root, strict.pin, strict.limit);
      await checked.close();
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Length", metadata.size);
      if (req.method === "HEAD" || metadata.size === 0) { res.end(); return; }
      // No path reopen; stream only the validated descriptor and declared bytes.
      await pipeline(file.createReadStream({ autoClose: false, start: 0, end: metadata.size - 1 }), res);
    } catch {
      if (!res.headersSent && !res.destroyed) {
        res.removeHeader("Content-Length");
        res.status(404).end();
      }
      else if (!res.destroyed) res.destroy();
    } finally {
      await Promise.allSettled([file, directory, root].filter(
        (h): h is FileHandle => !!h).map(h => h.close()));
    }
  });
  router.use(express.static(legacyRoot, { index: false, redirect: false, fallthrough: false,
    setHeaders: res => {
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  }));
  return router;
}
