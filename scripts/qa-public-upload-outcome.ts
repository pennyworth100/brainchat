import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import express from "express";
import multer from "multer";
import ts from "typescript";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { rooms as roomsTable, messages as messagesTable } from "../src/lib/db/schema";
import { createUploadParser } from "../src/lib/upload-parser";

// Characterization, NOT a correctness test: currently proves a dangling DB
// reference after a committed INSERT whose result is lost. No server startup,
// production imports, authentication, Socket.IO transport or live volumes.
async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  assert.ok(connectionString, "RESUME_TEST_DATABASE_URL required (isolated DB only)");
  const target = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "loopback DB only");
  const source = await fs.promises.readFile("server.ts", "utf8");
  const tree = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true);
  const functions = new Map<string, string>();
  const handlers: string[] = [], stores: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name &&
        ["saveMessage", "touchRoom", "deserializeMessage"].includes(node.name.text)) {
      assert.ok(!functions.has(node.name.text)); functions.set(node.name.text, node.getText(tree));
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "storage" && node.initializer) {
      stores.push(node.initializer.getText(tree));
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "expressApp.post" &&
        node.arguments[0]?.getText(tree) === '"/api/upload"') {
      const handler = node.arguments.at(-1)!;
      assert.ok(ts.isArrowFunction(handler)); handlers.push(handler.getText(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(functions.size, 3); assert.equal(handlers.length, 1); assert.equal(stores.length, 1);
  const schema = "public_upload_qa_" + crypto.randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema, connectionTimeoutMillis: 2000 });
  const root = await fs.promises.mkdtemp(path.join(tmpdir(), "dimle-public-outcome-"));
  const query = pool.query.bind(pool);
  let mode = "normal", insertAttempts = 0, committed = 0, emitted = 0, created = false;
  const writes = new Set<Promise<unknown>>(), unlinks: Promise<unknown>[] = [];
  const errors: string[] = [];
  // Throw ONLY after the real PG query resolves: an acknowledged autocommit
  // happened, but its result is deliberately hidden from Drizzle/the handler.
  // This is deterministic fault injection, not a network/power-loss simulation.
  (pool as unknown as { query: (...args: any[]) => Promise<any> }).query = (...args: any[]) => {
    const sql = typeof args[0] === "string" ? args[0] : args[0].text;
    const insert = /^insert into "messages"/i.test(sql);
    const work = (async () => {
      if (insert) {
        insertAttempts++;
        if (mode === "before-insert") throw Error("injected pre-insert rejection");
      }
      const result = await (query as (...args: any[]) => Promise<any>)(...args);
      if (insert) {
        committed++;
        if (mode === "after-commit") throw Error("injected lost INSERT result after autocommit");
      }
      return result;
    })();
    writes.add(work);
    void work.then(() => writes.delete(work), () => writes.delete(work));
    return work;
  };
  const context = vm.createContext({
    db: drizzle(pool), messagesTable, roomsTable, eq, Date, JSON, crypto, path, multer,
    UPLOAD_DIR: root,
    fs: { ...fs, promises: { ...fs.promises, unlink: (file: string) => {
      assert.ok(file.startsWith(root + path.sep));
      const result = fs.promises.unlink(file); unlinks.push(result); return result;
    } } },
    console: { error: () => errors.push(mode) },
    io: { to: () => ({ emit: () => {
      if (mode === "after-save-emit") throw Error("injected emit failure after save");
      emitted++;
    } }) },
  });
  const compiled = ts.transpileModule([...functions.values(),
    "globalThis.handler = (" + handlers[0] + ");",
    "globalThis.storage = (" + stores[0] + ");"].join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInContext(compiled, context);
  const app = express();
  app.post("/api/upload", (_req, res, next) => {
    // Deliberately substituted admission: tests begin after authentication.
    res.locals.uploadIdentity = { roomId: "proof123", username: "Fixture" }; next();
  }, createUploadParser(context.storage, 1024), context.handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const results: object[] = [];
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await pool.query((await fs.promises.readFile("drizzle/0000_thin_stardust.sql", "utf8"))
      .replaceAll('"public".', '"' + schema + '".'));
    await pool.query("ALTER TABLE messages ADD COLUMN client_message_id text");
    await pool.query("INSERT INTO rooms (id) VALUES ('proof123')");
    for (const scenario of ["normal", "before-insert", "after-commit", "after-save-emit"]) {
      mode = scenario; insertAttempts = 0; committed = 0; emitted = 0; unlinks.length = 0;
      const body = new FormData(), bytes = "fixture:" + scenario;
      body.append("file", new Blob([bytes], { type: "text/plain" }), scenario + ".txt");
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/upload`, {
        method: "POST", body, signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json();
      await Promise.allSettled([...writes]);
      const cleanup = await Promise.allSettled(unlinks);
      assert.ok(cleanup.every(r => r.status === "fulfilled"));
      assert.equal(insertAttempts, 1, "no retry/replay");
      const rows = (await admin.query(`SELECT id, content FROM "${schema}".messages
        WHERE content::jsonb->>'name' = $1`, [scenario + ".txt"])).rows;
      const expectedRows = scenario === "before-insert" ? 0 : 1;
      assert.equal(rows.length, expectedRows); assert.equal(committed, expectedRows);
      assert.equal(response.status, scenario === "normal" ? 200 : 500);
      assert.equal(emitted, scenario === "normal" ? 1 : 0);
      assert.equal(unlinks.length, scenario === "normal" ? 0 : 1);
      let blobExists = false;
      if (rows.length) {
        const metadata = JSON.parse(rows[0].content);
        assert.match(metadata.url, /^\/uploads\/[a-f0-9]{16}\/[\w.-]+$/);
        const file = path.join(root, metadata.url.slice("/uploads/".length));
        try {
          assert.equal(await fs.promises.readFile(file, "utf8"), bytes); blobExists = true;
        } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
        if (scenario === "normal") assert.equal(payload.message.id, rows[0].id);
      }
      assert.equal(blobExists, scenario === "normal");
      // Count all fixture files too: absence is not just a wrong-path check.
      let allFiles = 0;
      for (const token of await fs.promises.readdir(root)) {
        allFiles += (await fs.promises.readdir(path.join(root, token))).length;
      }
      assert.equal(allFiles, 1, "only normal-case blob remains");
      results.push({ scenario, http: response.status, insertAttempts, committed,
        independentlyObservedRows: rows.length, blobExists, emitted, cleanupCalls: unlinks.length });
    }
    assert.deepEqual(errors, ["before-insert", "after-commit", "after-save-emit"]);
    console.log(JSON.stringify({ result: "COUNTEREXAMPLES_CONFIRMED", scenarios: results,
      sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      serverSha256: crypto.createHash("sha256").update(source).digest("hex"),
      harnessSha256: crypto.createHash("sha256").update(await fs.promises.readFile("scripts/qa-public-upload-outcome.ts")).digest("hex"),
      scope: "actual AST-extracted storage/save/handler; real HTTP/multipart/PG/files; substituted admission and event emitter; minimal schema; no live state",
    }, null, 2));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...writes, ...unlinks]);
    await pool.end();
    if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
