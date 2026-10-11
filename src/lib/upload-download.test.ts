import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createUploadDownloadRouter, type StrictDownloadSource } from "./upload-download";
import { bindStrictUploadRoot } from "./upload-storage-root";
import { pinStrictUploadResourcePolicy } from "./upload-resource-policy-pin";

const key = "a".repeat(64), old = "b".repeat(16);
async function fixture(t: TestContext, enabled = true,
  configure: (source: StrictDownloadSource) => StrictDownloadSource = source => source) {
  const parent = await fs.mkdtemp(join(tmpdir(), "dimle-download-"));
  const rootPath = join(parent, "strict-root");
  await fs.mkdir(rootPath, { mode: 0o700 });
  await fs.mkdir(join(rootPath, key), { mode: 0o700 });
  await fs.writeFile(join(rootPath, key, "blob"), "abc", { mode: 0o600 });
  await fs.mkdir(join(parent, old));
  await fs.writeFile(join(parent, old, "report..pdf"), "legacy");
  await fs.mkdir(join(parent, key));
  await fs.writeFile(join(parent, key, "blob"), "WRONG LEGACY ROOT");
  await fs.writeFile(join(parent, "backup.sql"), "secret backup");
  const st = await fs.stat(rootPath, { bigint: true });
  const identity = { database: "fixture", schema: "public", quotaDomain: "test",
    namespace: rootPath, policyVersion: "v1", writerGeneration: "g1" };
  // Synthetic read-only policy fixture; NOT production physical authority.
  const policy = { identity, adapter: "resume-strict-writer-v1",
    layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
    stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 10,
    allocationUnitBytes: 4096, allocationCopies: 1, directoryAndParentBytes: 4096,
    metadataBytes: 4096, temporaryBytes: 0, additionalObjects: 0 };
  const pin = pinStrictUploadResourcePolicy(policy, identity)!;
  const root = bindStrictUploadRoot(pin, policy, { path: rootPath, device: st.dev.toString(),
    inode: st.ino.toString(), uid: process.geteuid!(), gid: process.getegid!() })!;
  let lookups = 0, visible = true;
  const metadata = { storageKey: key, name: "file.txt", mime: "text/plain", size: 3,
    sha256: createHash("sha256").update("abc").digest("hex") };
  const source: StrictDownloadSource = { root, pin, limit: 10,
    async publishedFile() { lookups++; return visible ? metadata : null; } };
  const app = express();
  app.use("/uploads", createUploadDownloadRouter(parent, enabled ? configure(source) : null));
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(parent, { recursive: true, force: true });
  });
  const address = server.address() as import("node:net").AddressInfo;
  function request(path: string, method = "GET") {
    return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: address.port, path: "/uploads" + path, method },
        res => { let body = ""; res.on("data", b => { body += b; });
          res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers })); });
      req.on("error", reject); req.end();
    });
  }
  return { parent, rootPath, metadata, source, request, lookups: () => lookups,
    hide: () => { visible = false; } };
}
test("strict GET and HEAD map only exact bound root, never legacy collision", async t => {
  const f = await fixture(t);
  const r = await f.request("/" + key + "/blob");
  assert.equal(r.status, 200); assert.equal(r.body, "abc");
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.headers["content-disposition"], "attachment");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  const head = await f.request("/" + key + "/blob", "HEAD");
  assert.equal(head.status, 200); assert.equal(head.body, ""); assert.equal(head.headers["content-length"], "3");
  const legacy = await f.request("/" + old + "/report..pdf");
  assert.equal(legacy.status, 200); assert.equal(legacy.body, "legacy");
});
test("missing provider denies strict before lookup; no legacy fallback", async t => {
  const f = await fixture(t, false);
  const r = await f.request("/" + key + "/blob");
  assert.equal(r.status, 503); assert.equal(r.body, ""); assert.equal(f.lookups(), 0);
});
test("backup parents, nested roots, traversal, malformed encoding and suffixes never serve", async t => {
  const f = await fixture(t);
  for (const path of ["/backup.sql", "/strict-root/" + key + "/blob", "/" + key + "/",
    "/" + key + "/blob/extra", "/" + key + "/blob%0a", "/" + key + "/other",
    "/" + old + "/../backup.sql", "/" + old + "/%2e%2e%5cbackup.sql",
    "/" + old + "/%252e%252e", "/%ZZ", "/" + key + "%0a/blob"]) {
    const r = await f.request(path); assert.ok(r.status >= 400, path); assert.ok(!r.body.includes("secret backup"), path);
  }
  assert.equal(f.lookups(), 0);
});
test("unpublished or mismatched committed metadata cannot reveal staged bytes", async t => {
  const f = await fixture(t); f.hide();
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  assert.equal(f.lookups(), 1);
  const g = await fixture(t); g.metadata.storageKey = "c".repeat(64);
  assert.equal((await g.request("/" + key + "/blob")).status, 404);
});
test("wrong size, widened mode and hardlink are denied", async t => {
  const f = await fixture(t), blob = join(f.rootPath, key, "blob");
  f.metadata.size = 2;
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  f.metadata.size = 3; await fs.chmod(blob, 0o644);
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  await fs.chmod(blob, 0o600); await fs.link(blob, join(f.parent, "link"));
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
});
test("symlink file and symlink directory cannot escape the strict root", async t => {
  const f = await fixture(t), blob = join(f.rootPath, key, "blob");
  await fs.unlink(blob); await fs.symlink(join(f.parent, "backup.sql"), blob);
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  await fs.rm(join(f.rootPath, key), { recursive: true });
  await fs.symlink(join(f.parent, key), join(f.rootPath, key));
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
});
test("root replacement and permission drift deny before publication lookup", async t => {
  const f = await fixture(t);
  await fs.chmod(f.rootPath, 0o750);
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  assert.equal(f.lookups(), 0);
  await fs.rename(f.rootPath, join(f.parent, "original"));
  await fs.mkdir(f.rootPath, { mode: 0o700 });
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  assert.equal(f.lookups(), 0);
});
test("strict methods do not consult publication or read files", async t => {
  const f = await fixture(t);
  const r = await f.request("/" + key + "/blob", "POST");
  assert.equal(r.status, 405); assert.equal(r.headers.allow, "GET, HEAD"); assert.equal(f.lookups(), 0);
});

test("copied root capabilities and unavailable publication fail closed without fallback", async t => {
  const f = await fixture(t, true, source => ({ ...source, root: { ...source.root } }));
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  assert.equal(f.lookups(), 0);
  const g = await fixture(t, true, source => ({ ...source,
    async publishedFile() { throw Error("DB unavailable"); } }));
  assert.equal((await g.request("/" + key + "/blob")).status, 404);
});

test("FIFO corruption never blocks the download handler", { timeout: 3000 }, async t => {
  const f = await fixture(t), blob = join(f.rootPath, key, "blob");
  await fs.unlink(blob); await promisify(execFile)("mkfifo", ["-m", "600", blob]);
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
});

test("concurrent successful and denied downloads close every opened descriptor", async t => {
  const f = await fixture(t), original = fs.open;
  let opened = 0;
  const closed = new Set<Awaited<ReturnType<typeof fs.open>>>();
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await original(...args), close = h.close.bind(h); opened++;
    // FileHandle/ReadStream may call idempotent close recursively on one handle.
    t.mock.method(h, "close", async () => { await close(); closed.add(h); });
    return h;
  });
  const results = await Promise.all(Array.from({ length: 16 }, () => f.request("/" + key + "/blob")));
  assert.ok(results.every(r => r.status === 200 && r.body === "abc"));
  f.hide();
  assert.equal((await f.request("/" + key + "/blob")).status, 404);
  for (let i = 0; i < 100 && closed.size !== opened; i++) await new Promise<void>(r => setImmediate(r));
  assert.ok(opened >= 65); assert.equal(closed.size, opened);
});
