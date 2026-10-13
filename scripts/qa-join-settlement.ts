import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { Pool } from "pg";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { Server, type Socket } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { consumeJoinLimits } from "../src/lib/join-rate-limits";
import { attachResumeSocket, type ResumeSocketOwner } from "../src/lib/resume-socket";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeMemberships } from "../src/lib/resume-membership";

// Actual adapter SQL + owner + Socket.IO; owned schema only, NOT server-wide drain.
async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  assert.ok(connectionString && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const schema = "join_qa_" + crypto.randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString });
  const writer = new Pool({ connectionString, options: "-c search_path=" + schema,
    application_name: schema });
  const lock = await admin.connect();
  const server = http.createServer(), io = new Server(server);
  const clients: ClientSocket[] = [], owners: ResumeSocketOwner[] = [];
  let locked = false, created = false;
  const waitForLock = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await admin.query("SELECT pid, query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema]);
      if (rows.rowCount === 1) return rows.rows[0];
      assert.ok(Date.now() < deadline, "actual PostgreSQL writer did not enter lock wait");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const hold = async (table: string) => {
    await lock.query("BEGIN"); locked = true;
    await lock.query('LOCK TABLE "' + schema + '".' + table + ' IN ACCESS EXCLUSIVE MODE');
  };
  const release = async () => { await lock.query("COMMIT"); locked = false; };
  const socket = async () => {
    const arrived = new Promise<Socket>(resolve => io.once("connection", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const client = connect("http://127.0.0.1:" + address.port,
      { transports: ["websocket"], reconnection: false, forceNew: true });
    clients.push(client); return arrived;
  };
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await writer.query("CREATE TABLE rate_limits(key varchar(255) PRIMARY KEY, points integer NOT NULL DEFAULT 0, expire bigint)");
    const options = { storeClient: writer, storeType: "pool" as const, schemaName: schema,
      tableCreated: true, clearExpiredByTimeout: false, points: 20, duration: 60 };
    const missing = new RateLimiterPostgres({ ...options, tableName: "missing", keyPrefix: "join-ip" });
    const limiter = new RateLimiterPostgres({ ...options, tableName: "rate_limits", keyPrefix: "join-room" });
    await hold("rate_limits");
    let failed = false, finished = false;
    const flight = consumeJoinLimits({ consume: key => missing.consume(key).catch(error => {
      failed = true; throw error;
    }) }, limiter, "ip", "candy986").then(
      () => { throw Error("missing limiter table should reject"); },
      error => { finished = true; assert.equal(error.code, "42P01"); });
    const waiting = await waitForLock();
    assert.match(waiting.query, /INSERT INTO/);
    // Allow the independent missing-table rejection to be delivered.
    const deadline = Date.now() + 5000;
    while (!failed) {
      assert.ok(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(finished, false, "early sibling failure must not end limiter settlement");
    await release(); await flight;
    assert.equal((await writer.query("SELECT points FROM rate_limits")).rows[0].points, 1);

    for (const file of ["0000_thin_stardust.sql", "0004_long_nighthawk.sql"]) {
      await writer.query((await readFile("drizzle/" + file, "utf8"))
        .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"'));
    }
    await writer.query("ALTER TABLE rooms ADD COLUMN creation_token_hash text");
    await writer.query("INSERT INTO rooms(id) VALUES('candy986')");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const store = new ResumeStore(writer);
    let advances = 0, publications = 0;
    for (const outcome of ["commit", "cancel"] as const) {
      const physical = await socket(), bindings = new ResumeBindings(), errors: unknown[] = [];
      const owner = attachResumeSocket(physical, {
        store: { advanceGeneration: async (...args) => { advances++; return store.advanceGeneration(...args); } },
        bindings, memberships: new ResumeMemberships(bindings), timeoutMs: 250,
        issue: (...args) => store.issueAfterAuthenticatedJoin(...args),
        prepare: async () => async () => {},
        publishJoin: async () => { publications++; return true; },
        onCleanupError: error => { errors.push(error); },
      });
      owners.push(owner);
      await hold("room_resume_sessions");
      const join = owner.join({ roomId: "candy986", username: outcome, authVersion: 1 });
      const waiting = await waitForLock(); assert.match(waiting.query, /INSERT INTO room_resume_sessions/);
      assert.equal(await join, null); assert.equal(physical.connected, false);
      let closed = false;
      const closing = owner.close(); assert.equal(owner.close(), closing);
      void closing.then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false, "close must wait beyond timeout while INSERT is locked");
      if (outcome === "cancel") {
        assert.equal((await admin.query("SELECT pg_cancel_backend($1) AS cancelled", [waiting.pid])).rows[0].cancelled, true);
      }
      await release(); await closing;
      assert.equal(advances, 0); assert.equal(publications, 0);
      assert.equal(errors.length, outcome === "cancel" ? 1 : 0);
      assert.equal(await owner.join({ roomId: "candy986", username: outcome, authVersion: 1 }), null);
      const rows = await writer.query("SELECT username, generation FROM room_resume_sessions");
      assert.deepEqual(rows.rows, [{ username: "commit", generation: 0 }]);
    }
    console.log(JSON.stringify({ result: "JOIN_SETTLEMENT_PG_PASS", siblingFailureWaitsForLockedConsume: true,
      timeoutCloseWaitsForLockedIssuance: true, cancelledSQLSettlesAndReportsOnce: true,
      lateGeneration: 0, advances, publications, noReplay: true,
      scope: "actual RateLimiterPostgres, ResumeStore, Socket.IO and owner; no whole-server drain" }));
  } finally {
    if (locked) await lock.query("ROLLBACK");
    await Promise.allSettled(owners.map(owner => owner.close()));
    for (const client of clients) client.disconnect();
    await new Promise<void>(resolve => io.close(() => resolve()));
    lock.release(); await writer.end();
    if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
