import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import multer from "multer";
import { createUploadParser } from "./upload-parser";

// Namespace substitution is confined to an owned fixture AFTER storage completes.
// The real, unmodified disk._removeFile calls the real fs.unlink. No fs mock,
// permission simulation, live upload, retry or reclamation authority is involved.
for (const mode of ["success", "missing-path", "directory-path"] as const) {
  test(`real disk removal metadata: ${mode}`, { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "dimle-remove-metadata-"));
    const target = path.join(root, "owned.txt"), retained = path.join(root, "retained.txt");
    const counts = { handle: 0, remove: 0, removeCallback: 0, parser: 0 };
    const events: string[] = [];
    type RemovalError = NodeJS.ErrnoException & { file?: Express.Multer.File; field?: string };
    let removalError: RemovalError | null | undefined;
    let parserError: (Error & { code?: string; storageErrors?: RemovalError[] }) | undefined;
    let removedFile: Express.Multer.File | undefined;
    let identity: Readonly<{ path: string; filename: string; destination: string }> | undefined;
    let fixtureFailure: unknown;
    const disk = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, root),
      filename: (_req, _file, cb) => cb(null, "owned.txt"),
    });
    const storage: multer.StorageEngine = {
      _handleFile(req, file, cb) {
        disk._handleFile(req, file, (err, info) => {
          counts.handle++;
          events.push("handle-callback");
          cb(err, info);
        });
      },
      _removeFile(req, file, cb) {
        counts.remove++;
        removedFile = file;
        identity = Object.freeze({ path: file.path, filename: file.filename, destination: file.destination });
        void (async () => {
          assert.equal(counts.handle, 1);
          assert.equal(await readFile(target, "utf8"), "abcdefg");
          if (mode !== "success") {
            await rename(target, retained);
            if (mode === "directory-path") await mkdir(target);
          }
          events.push("disk-remove-enter");
          disk._removeFile(req, file, (err) => {
            counts.removeCallback++;
            removalError = err;
            events.push("disk-remove-callback");
            cb(err);
          });
          // Deletion is synchronous, before the asynchronous unlink callback.
          for (const key of ["path", "filename", "destination"] as const) {
            assert.equal(Object.hasOwn(file, key), false);
          }
          assert.equal(counts.removeCallback, 0);
        })().catch((error) => { fixtureFailure = error; cb(error); });
      },
    };
    const app = express();
    const parser = createUploadParser(storage, 6);
    app.post("/", (req, res) => parser(req, res, (err) => {
      counts.parser++;
      parserError = err;
      events.push("parser-callback");
      res.status(err ? 400 : 200).end();
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=metadata" },
      body: '--metadata\r\nContent-Disposition: form-data; name="file"; filename="owned.txt"\r\nContent-Type: text/plain\r\n\r\nabcdefg\r\n--metadata--\r\n',
      signal: AbortSignal.timeout(3000),
    });
    await response.arrayBuffer();
    assert.equal(fixtureFailure, undefined);
    assert.equal(response.status, 400);
    assert.equal(parserError?.code, "LIMIT_FILE_SIZE");
    assert.deepEqual(counts, { handle: 1, remove: 1, removeCallback: 1, parser: 1 });
    assert.deepEqual(events, ["handle-callback", "disk-remove-enter", "disk-remove-callback", "parser-callback"]);
    assert.deepEqual(identity, { path: target, filename: "owned.txt", destination: root });
    assert.equal(Object.isFrozen(identity), true);
    for (const key of ["path", "filename", "destination"] as const) {
      assert.equal(Object.hasOwn(removedFile!, key), false);
    }
    if (mode === "success") {
      assert.equal(removalError, null);
      assert.deepEqual(parserError?.storageErrors, []);
      assert.deepEqual(await readdir(root), []);
    } else {
      assert.ok(removalError);
      if (mode === "missing-path") assert.equal(removalError.code, "ENOENT");
      else assert.ok(["EISDIR", "EPERM"].includes(removalError.code ?? ""));
      assert.equal(removalError.syscall, "unlink");
      assert.equal(removalError.path, target, "OS error has its own path, not file.path");
      assert.equal(removalError.file, removedFile);
      assert.equal(removalError.field, "file");
      assert.deepEqual(parserError?.storageErrors, [removalError]);
      assert.equal(await readFile(retained, "utf8"), "abcdefg");
      assert.deepEqual((await readdir(root)).sort(), mode === "missing-path" ? ["retained.txt"] : ["owned.txt", "retained.txt"]);
    }
    t.diagnostic(JSON.stringify({ mode, counts, events, code: removalError?.code ?? null,
      fileIdentityDeleted: true, retainedBytes: mode === "success" ? 0 : 7 }));
  });
}
