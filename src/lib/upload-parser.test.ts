import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import multer from "multer";
import { createUploadParser } from "./upload-parser";

const boundary = "dimle-security-boundary";
const field = (name: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\nx\r\n`;
const file = (data: string, name = "file") => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n${data}\r\n`;
const end = `--${boundary}--\r\n`;

async function fixture(t: TestContext, failSink = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dimle-parser-"));
  const dest = failSink ? path.join(root, "not-a-directory") : root;
  if (failSink) await writeFile(dest, "occupied");
  const app = express();
  let settlements = 0;
  let accepted = 0;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const parser = createUploadParser(multer.diskStorage({ destination: (_req, _file, cb) => cb(null, dest) }), 6);
  app.post("/", (req, res) => {
    parser(req, res, (error) => {
      settlements++;
      settle();
      if (error) return res.status(400).json({ error: error.code || error.message });
      if (!req.file) return res.status(400).json({ error: "NO_FILE" });
      accepted++;
      res.json({ size: req.file.size });
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, url, settled, counts: () => ({ settlements, accepted }),
    send: (body: string) => fetch(url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body, signal: AbortSignal.timeout(2000) }) };
}

for (const data of ["abc", "abcdef"]) {
  test(`disk upload accepts ${data.length} bytes (inclusive bound)`, { timeout: 4000 }, async (t) => {
    const f = await fixture(t);
    const res = await f.send(file(data) + end);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { size: data.length });
    const names = await readdir(f.root);
    assert.equal(names.length, 1);
    assert.equal(await readFile(path.join(f.root, names[0]), "utf8"), data);
    assert.deepEqual(f.counts(), { settlements: 1, accepted: 1 });
  });
}

for (const [name, body] of Object.entries({
  overlimit: file("abcdefg") + end,
  fieldBeforeFile: field("a[999999999]") + field("a[key]") + file("abc") + end,
  fieldAfterFile: file("abc") + field("extra") + end,
  secondFile: file("abc") + file("def") + end,
  wrongFileField: file("abc", "wrong") + end,
  truncated: file("abc"),
  malformed: `--${boundary}\r\nInvalid header\r\n\r\nx\r\n${end}`,
  empty: end,
})) {
  test(`disk upload denies ${name}, settles once and removes files`, { timeout: 4000 }, async (t) => {
    const f = await fixture(t);
    const res = await f.send(body);
    assert.equal(res.status, 400);
    await res.arrayBuffer();
    assert.deepEqual(f.counts(), { settlements: 1, accepted: 0 });
    assert.deepEqual(await readdir(f.root), []);
  });
}

test("disk sink failure settles once without accepting", { timeout: 4000 }, async (t) => {
  const f = await fixture(t, true);
  const res = await f.send(file("abc") + end);
  assert.equal(res.status, 400);
  await res.arrayBuffer();
  assert.deepEqual(f.counts(), { settlements: 1, accepted: 0 });
  assert.deepEqual(await readdir(f.root), ["not-a-directory"]);
});

test("client disconnect settles and removes partially written disk file", { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  const req = http.request(f.url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": "10000" } });
  req.on("error", () => {});
  req.write(file("abc"));
  // Wait for evidence that the disk sink opened, not an arbitrary timing guess.
  for (let i = 0; i < 100 && !(await readdir(f.root)).length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await readdir(f.root)).length, 1);
  req.destroy();
  await f.settled;
  assert.deepEqual(f.counts(), { settlements: 1, accepted: 0 });
  assert.deepEqual(await readdir(f.root), []);
});
