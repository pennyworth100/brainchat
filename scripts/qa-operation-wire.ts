// Opt-in owned-loopback PostgreSQL wire faults; never public route activation.
import assert from "node:assert/strict";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeUploadAdmissions } from "../src/lib/resume-upload-admission";
import { ResumeOperationGate, ResumeUploadOperationGate } from "../src/lib/resume-operation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function scenario(url: string, mode: "socket" | "upload", phase: "before-commit" | "commit-ack") {
  const schema = "operation_wire_" + randomBytes(8).toString("hex");
  const wireDone = deferred(), workPaused = deferred(), resumeWork = deferred();
  const wire = { commits: 0, withheldBytes: 0, tags: [] as string[], types: [] as string[] };
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer(client => {
    const upstream = net.connect(Number(new URL(url).port), "127.0.0.1");
    sockets.add(client); sockets.add(upstream);
    let front = Buffer.alloc(0), back = Buffer.alloc(0), startup = true, suppress = false;
    client.on("error", () => {}); upstream.on("error", () => client.destroy());
    client.on("close", () => { sockets.delete(client); upstream.destroy(); });
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    client.on("data", chunk => {
      front = Buffer.concat([front, chunk]);
      while (front.length >= (startup ? 4 : 5)) {
        const n = startup ? front.readUInt32BE(0) : 1 + front.readUInt32BE(1);
        assert(n >= 5 && n < 1_000_000);
        if (front.length < n) break;
        const frame = front.subarray(0, n); front = front.subarray(n);
        if (!startup && frame[0] === 81 && frame.subarray(5).toString() === "COMMIT\0") {
          wire.commits++; suppress = true;
        }
        startup = false; upstream.write(frame);
      }
    });
    upstream.on("data", chunk => {
      if (!suppress) { client.write(chunk); return; }
      wire.withheldBytes += chunk.length; back = Buffer.concat([back, chunk]);
      while (back.length >= 5) {
        const n = 1 + back.readUInt32BE(1);
        assert(n >= 5 && n < 1_000_000);
        if (back.length < n) break;
        const frame = back.subarray(0, n); back = back.subarray(n);
        const kind = String.fromCharCode(frame[0]); wire.types.push(kind);
        if (kind === "C") wire.tags.push(frame.subarray(5, -1).toString());
        if (kind === "Z") { assert.equal(frame[5], 73); wireDone.resolve(); }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve);
  });
  const proxyUrl = new URL(url);
  proxyUrl.port = String((proxy.address() as net.AddressInfo).port);
  const options = { options: "-c search_path=" + schema, max: 1, connectionTimeoutMillis: 5000 };
  const pool = new Pool({ ...options, connectionString: proxyUrl.href });
  const observer = new Pool({ ...options, connectionString: url });
  // No extra checked-out client error listener: the product gate must own it.
  const queries: string[] = [], releases: boolean[] = [];
  let checkout: PoolClient | undefined, settled = false, commitResolved = false;
  let pending: Promise<unknown> | undefined;
  try {
    await observer.query('CREATE SCHEMA "' + schema + '"');
    for (const name of ["0000_thin_stardust", "0003_spotty_zombie", "0004_long_nighthawk", "0005_free_blazing_skull"]) {
      const sql = (await readFile("drizzle/" + name + ".sql", "utf8"))
        .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"');
      await observer.query(sql);
    }
    await observer.query("INSERT INTO rooms (id) VALUES ('local986')");
    const sessionId = randomUUID(), transport = "wire_transport_01";
    await observer.query("INSERT INTO room_resume_sessions (id,room_id,username,token_hash,auth_version,generation,last_transport_id,expires_at) VALUES ($1,'local986','diagnostic',$2,1,1,$3,clock_timestamp()+interval '1 hour')",
      [sessionId, "a".repeat(64), transport]);
    await observer.query("CREATE TABLE diagnostic_receipts (id text PRIMARY KEY)");
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({ sessionId, generation: 1, roomId: "local986",
      username: "diagnostic", authVersion: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
      transport, async () => {}, () => true);
    assert(binding);
    const admissions = new ResumeUploadAdmissions(bindings), grant = admissions.admit(binding);
    assert(grant);
    const checkedPool = { connect: async () => {
      const client = await pool.connect(); checkout = client;
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = (async (sql: string, args?: unknown[]) => {
        queries.push(sql);
        const result = await query(sql, args);
        if (sql === "COMMIT") commitResolved = true;
        return result;
      }) as typeof client.query;
      client.release = (broken?: boolean | Error) => { releases.push(broken === true); release(broken); };
      return client;
    } };
    const work = async (tx: Pick<PoolClient, "query">) => {
      await tx.query("INSERT INTO diagnostic_receipts VALUES ($1)", [mode]);
      workPaused.resolve();
      if (phase === "before-commit") await resumeWork.promise;
      return "must-not-publish";
    };
    const outcomePromise = (mode === "socket"
      ? new ResumeOperationGate(checkedPool, bindings).runWithOutcome(binding, work)
      : new ResumeUploadOperationGate(checkedPool, admissions).runWithOutcome(grant, work))
      .then(result => { settled = true; return result; });
    pending = outcomePromise;
    await workPaused.promise;
    assert(checkout);
    const listeners = checkout.listeners("error");
    assert.equal(listeners.length, 1);
    if (phase === "commit-ack") {
      await wireDone.promise;
      assert.deepEqual(wire.tags, ["COMMIT"]);
      assert.deepEqual(wire.types, ["C", "Z"]);
      assert(wire.withheldBytes > 0);
    }
    const expected = phase === "commit-ack" ? [{ id: mode }] : [];
    assert.deepEqual((await observer.query("SELECT * FROM diagnostic_receipts")).rows, expected);
    assert(!settled); assert(!commitResolved); assert.deepEqual(releases, []);
    // pg's internal stream observation is fixture-only; do not mask error events.
    const stream = (checkout as PoolClient & { connection: { stream: net.Socket } }).connection.stream;
    const closed = new Promise<void>(r => stream.once("close", () => r()));
    for (const socket of sockets) socket.destroy();
    await closed;
    if (phase === "before-commit") {
      assert(!settled); assert.deepEqual(releases, []);
      await observer.query("BEGIN");
      await observer.query("SET LOCAL lock_timeout = 1000");
      await observer.query("SELECT id FROM room_resume_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
      await observer.query("ROLLBACK");
      assert.deepEqual((await observer.query("SELECT * FROM diagnostic_receipts")).rows, []);
      resumeWork.resolve();
    }
    const outcome = await outcomePromise;
    assert(!outcome.completed);
    assert.equal(outcome.commit, phase === "commit-ack" ? "unknown" : "not-dispatched");
    assert(outcome.error instanceof Error);
    assert.match(outcome.error.message, /Connection terminated/);
    assert.deepEqual(releases, [true]);
    assert.equal(wire.commits, phase === "commit-ack" ? 1 : 0);
    assert.equal(queries.filter(sql => sql === "COMMIT").length, wire.commits);
    assert.deepEqual((await observer.query("SELECT * FROM diagnostic_receipts")).rows, expected);
    assert.equal(admissions.admit(binding), null);
    assert(!checkout.listeners("error").includes(listeners[0]));
    assert.equal(checkout.listenerCount("error"), 1); // pg-pool restored its idle owner.
    return { mode, phase, wire, commit: outcome.commit, releases, receipts: expected.length };
  } finally {
    resumeWork.resolve();
    for (const socket of sockets) socket.destroy();
    await pending;
    await pool.end();
    await observer.query("ROLLBACK");
    await observer.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await observer.end();
    await new Promise<void>(r => proxy.close(() => r()));
  }
}

async function main() {
  const url = process.env.RESUME_TEST_DATABASE_URL;
  assert(url, "RESUME_TEST_DATABASE_URL required; use the owned cluster runner");
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "postgresql:");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert(process.env.OWNED_PG_PORT);
  assert.equal(parsed.port, process.env.OWNED_PG_PORT);
  assert.equal(parsed.search, ""); // no host/service/TLS parameter overrides
  const rows = [];
  for (const phase of ["before-commit", "commit-ack"] as const)
    for (const mode of ["socket", "upload"] as const) rows.push(await scenario(url, mode, phase));
  console.log(JSON.stringify({ passed: rows.length, rows,
    limits: "Synthetic binding and diagnostic receipt; no message SQL, public route, managed failover, physical crash, or callback deadline guarantee." }, null, 2));
}
// Failure bound only, never used to order successful fault injection.
// The parent owns PostgreSQL and stops it even if this process times out/crashes.
const watchdog = setTimeout(() => { console.error("Wire fixture exceeded 30s"); process.exit(1); }, 30000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));

