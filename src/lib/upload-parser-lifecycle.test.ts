import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import multer from "multer";
import { createUploadParser } from "./upload-parser";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// Real loopback HTTP, Busboy, Multer 2.4 and disk writes. Gates control callback
// ordering, not clocks. These characterize middleware completion, not a global
// writer barrier, crash durability, fsync or every descriptor in the process.
for (const mode of ["destination", "filename", "visible-path", "info-only"] as const) {
  test(`aborted upload lifecycle: ${mode}`, { timeout: 8000 }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "dimle-lifecycle-"));
    const namingEntered = gate(), releaseNaming = gate();
    const storageEntered = gate(), releaseStorage = gate(), storageReturned = gate();
    const removeEntered = gate(), releaseRemove = gate(), removeReturned = gate();
    const parserReturned = gate(), requestAborted = gate();
    const events: string[] = [];
    const naming = mode === "destination" || mode === "filename";
    let parserCalls = 0, removeCalls = 0, handleCalls = 0;
    let parserError: Error | undefined, handleError: { code?: string } | null | undefined;
    let sourceFile: Express.Multer.File | undefined;
    let pathAtAbort: string | undefined;
    const disk = multer.diskStorage({
      destination: (_req, _file, cb) => {
        if (mode !== "destination") return cb(null, root);
        namingEntered.resolve();
        void releaseNaming.promise.then(() => cb(null, root));
      },
      filename: (_req, _file, cb) => {
        if (mode !== "filename") return cb(null, "owned.txt");
        namingEntered.resolve();
        void releaseNaming.promise.then(() => cb(null, "owned.txt"));
      },
    });
    const storage: multer.StorageEngine = {
      _handleFile(req, file, cb) {
        sourceFile = file;
        // info-only is an explicit alternate storage contract: path is returned
        // only in callback info, not mutated onto Multer's pending file object.
        // The actual production disk engine does mutate that object.
        const target = mode === "info-only" ? { ...file, stream: file.stream } : file;
        disk._handleFile(req, target, (err, info) => {
          handleError = err;
          storageEntered.resolve();
          const deliver = () => {
            handleCalls++;
            events.push("handle-callback");
            cb(err, info);
            storageReturned.resolve();
          };
          if (naming) deliver();
          else void releaseStorage.promise.then(deliver);
        });
      },
      _removeFile(req, file, cb) {
        removeCalls++;
        events.push("remove-enter");
        removeEntered.resolve();
        void releaseRemove.promise.then(() => disk._removeFile(req, file, (err) => {
          events.push("remove-return");
          cb(err);
          removeReturned.resolve();
        }));
      },
    };
    const parser = createUploadParser(storage, 1024);
    const app = express();
    app.post("/", (req, res) => {
      req.once("aborted", () => {
        pathAtAbort = sourceFile?.path;
        events.push("request-aborted");
        requestAborted.resolve();
      });
      parser(req, res, (err) => {
        parserCalls++;
        parserError = err;
        events.push("parser-return");
        parserReturned.resolve();
        if (!res.destroyed) res.status(err ? 400 : 200).end();
      });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const req = http.request({ hostname: "127.0.0.1", port: address.port, method: "POST", path: "/",
      headers: { "content-type": "multipart/form-data; boundary=lifecycle", "content-length": "10000" } });
    req.on("error", () => {}); // Client destruction is intentional.
    t.after(async () => {
      req.destroy();
      releaseNaming.resolve(); releaseStorage.resolve(); releaseRemove.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Wait on the callbacks we actually admitted before removing owned files.
      if (sourceFile) await storageReturned.promise;
      if (removeCalls) await removeReturned.promise;
      await rm(root, { recursive: true, force: true });
    });
    const part = '--lifecycle\r\nContent-Disposition: form-data; name="file"; filename="owned.txt"\r\nContent-Type: text/plain\r\n\r\nfixture-bytes';
    req.write(naming ? part : part + "\r\n--lifecycle--\r\n");
    await (naming ? namingEntered.promise : storageEntered.promise);
    assert.equal(parserCalls, 0);
    assert.equal(handleCalls, 0);
    if (naming) assert.deepEqual(await readdir(root), []);
    else assert.equal(await readFile(path.join(root, "owned.txt"), "utf8"), "fixture-bytes");
    req.destroy();
    await requestAborted.promise;
    if (naming) {
      await parserReturned.promise;
      assert.equal(pathAtAbort, undefined);
      assert.equal(handleCalls, 0, "parser returned while naming still gated");
      assert.deepEqual(await readdir(root), []);
      releaseNaming.resolve();
      await storageReturned.promise;
      assert.equal(handleError?.code, "STREAM_DESTROYED");
      assert.equal(removeCalls, 0, "destroyed source prevents late disk creation");
    } else if (mode === "visible-path") {
      await removeEntered.promise;
      assert.equal(pathAtAbort, path.join(root, "owned.txt"));
      assert.equal(parserCalls, 0, "initial cleanup waits for remove callback");
      assert.equal(handleCalls, 0);
      assert.deepEqual(await readdir(root), ["owned.txt"]);
      releaseRemove.resolve();
      await removeReturned.promise;
      await parserReturned.promise;
      assert.equal(handleCalls, 0, "parser completion still precedes handle callback");
      releaseStorage.resolve();
      await storageReturned.promise;
      assert.equal(removeCalls, 1, "late callback must not double-clean visible path");
    } else {
      await parserReturned.promise;
      assert.equal(pathAtAbort, undefined);
      assert.equal(handleCalls, 0);
      assert.equal(removeCalls, 0);
      assert.deepEqual(await readdir(root), ["owned.txt"], "parser returned before late cleanup");
      releaseStorage.resolve();
      await storageReturned.promise;
      await removeEntered.promise;
      assert.deepEqual(await readdir(root), ["owned.txt"], "late remove is still gated");
      assert.equal(parserCalls, 1);
      releaseRemove.resolve();
      await removeReturned.promise;
      assert.equal(removeCalls, 1);
    }
    assert.ok(parserError, "aborted request is rejected");
    assert.equal(parserCalls, 1);
    assert.equal(handleCalls, 1);
    assert.deepEqual(await readdir(root), [], "no extra fixture files after callback settlement");
    assert.ok(events.indexOf("parser-return") < events.indexOf("handle-callback"));
    t.diagnostic(JSON.stringify({ mode, events, parserCalls, handleCalls, removeCalls,
      parserError: parserError.message, handleError: handleError?.code ?? null, remainingFiles: 0 }));
  });
}
