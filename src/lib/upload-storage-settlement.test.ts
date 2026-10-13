import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { StorageEngine } from "multer";
import { createUploadParser } from "./upload-parser";
import { UploadStorageSettlement } from "./upload-storage-settlement";

test("real Multer abort returns early; retain late engine completion AND nested cleanup", async () => {
  const settlement = new UploadStorageSettlement();
  let entered!: () => void, parserReturned!: () => void;
  const entry = new Promise<void>(r => { entered = r; });
  const parserReturn = new Promise<void>(r => { parserReturned = r; });
  let finishWrite!: Parameters<StorageEngine["_handleFile"]>[2];
  let finishRemove!: Parameters<StorageEngine["_removeFile"]>[2];
  const engine = settlement.wrap({
    _handleFile: (_req, file, cb) => { file.stream.resume(); finishWrite = cb; entered(); },
    _removeFile: (_req, _file, cb) => { finishRemove = cb; },
  });
  const parser = createUploadParser(engine, 1024);
  const app = express(); let settled = false;
  let tracked!: Promise<void>;
  app.post("/", (req, res) => parser(req, res, () => {
    tracked = settlement.settle(req).then(() => { settled = true; res.end(); });
    parserReturned();
  }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const req = http.request({ host: "127.0.0.1", port: address.port, method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=testing", "Content-Length": "1000" } });
  req.on("error", () => {});
  try {
    req.write('--testing\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\npartial');
    await entry; req.destroy(); await parserReturn;
    assert.equal(settled, false, "Multer next(error) is not actual engine settlement");
    finishWrite(null, { path: "/fake-owned-fixture/x.txt", size: 7 });
    await new Promise(r => setImmediate(r));
    assert.equal(typeof finishRemove, "function");
    assert.equal(settled, false, "late abort cleanup is retained too");
    finishRemove(null); await tracked;
    assert.equal(settled, true);
  } finally {
    req.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
