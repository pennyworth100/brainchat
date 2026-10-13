import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { createUploadParser } from "./upload-parser";

// Real parser/disk/HTTP; mirrors public destination mkdir, not public auth/DB.
// No physical allocation, isolation, or live-volume quota claim.
for (const bytes of [6, 7, 1024 * 1024]) {
  test(`public parser cost: ${bytes} input bytes and retained destination`, { timeout: 8000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "dimle-resource-cost-"));
    const dir = path.join(root, "owned-destination");
    const counts = { destination: 0, handle: 0, remove: 0, removeCallback: 0, parser: 0 };
    let stored: Buffer | undefined;
    let fixtureFailure: unknown;
    let parserCode: string | undefined;
    const disk = multer.diskStorage({
      destination: (_req, _file, cb) => {
        counts.destination++;
        try { mkdirSync(dir, { recursive: true }); cb(null, dir); }
        catch (error) { cb(error as Error, dir); }
      },
      filename: (_req, _file, cb) => cb(null, "owned.txt"),
    });
    const storage: multer.StorageEngine = {
      _handleFile(req, file, cb) {
        counts.handle++;
        disk._handleFile(req, file, (error, info) => {
          // Hold the storage callback just long enough to inspect completed bytes,
          // before parser cleanup can unlink them. Never alter the source/sink.
          if (error) return cb(error);
          void readFile(path.join(dir, "owned.txt")).then((data) => {
            stored = data;
            cb(null, info);
          }, (error) => { fixtureFailure = error; cb(error); });
        });
      },
      _removeFile(req, file, cb) {
        counts.remove++;
        disk._removeFile(req, file, (error) => { counts.removeCallback++; cb(error); });
      },
    };
    const app = express();
    const parser = createUploadParser(storage, 6);
    app.post("/", (req, res) => parser(req, res, (error) => {
      counts.parser++;
      parserCode = error?.code;
      res.status(error ? 400 : 200).end();
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=cost" },
      body: Buffer.concat([
        Buffer.from('--cost\r\nContent-Disposition: form-data; name="file"; filename="owned.txt"\r\nContent-Type: application/octet-stream\r\n\r\n'),
        Buffer.alloc(bytes, 97), Buffer.from('\r\n--cost--\r\n'),
      ]),
      signal: AbortSignal.timeout(5000),
    });
    await response.arrayBuffer();
    assert.equal(fixtureFailure, undefined);
    const rejected = bytes > 6;
    assert.equal(response.status, rejected ? 400 : 200);
    assert.equal(parserCode, rejected ? "LIMIT_FILE_SIZE" : undefined);
    assert.deepEqual(stored, Buffer.alloc(Math.min(bytes, 7), 97));
    assert.deepEqual(counts, { destination: 1, handle: 1, remove: +rejected, removeCallback: +rejected, parser: 1 });
    assert.deepEqual(await readdir(root), ["owned-destination"]);
    assert.deepEqual(await readdir(dir), rejected ? [] : ["owned.txt"]);
    t.diagnostic(JSON.stringify({ inputBytes: bytes, observedFileBytes: stored?.length,
      retainedDirectories: 1, retainedFiles: rejected ? 0 : 1, counts }));
  });
}
