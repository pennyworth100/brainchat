import test from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ResumeUploadReservations } from "./resume-upload-reservation";
import fs from "node:fs/promises";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeFileStorage } from "./resume-file-storage";

const input = () => ({ sessionId: randomUUID(), roomId: "candy986", clientMessageId: "key", reservedBytes: 10 });
for (const mode of ["checkout", "begin", "insert", "commit", "release"] as const) {
  test(`reservation ${mode} failure preserves conservative outcome`, async () => {
    let commits = 0;
    const client = Object.assign(new EventEmitter(), { query: async (sql: string) => {
      if (sql === "COMMIT") commits++;
      if ((mode === "begin" && sql.startsWith("BEGIN")) ||
          (mode === "insert" && sql.startsWith("INSERT")) ||
          (mode === "commit" && sql === "COMMIT")) throw Error("controlled failure");
      return { rowCount: 1, command: sql.split(" ")[0] };
    }, release: () => { if (mode === "release") throw Error("controlled release failure"); } }) as unknown as PoolClient;
    const ledger = new ResumeUploadReservations({ connect: async () => {
      if (mode === "checkout") throw Error("controlled checkout failure");
      return client;
    } });
    const result = await ledger.reserve(input());
    assert.ok(result.status === "failed");
    assert.equal(result.commit, mode === "commit" || mode === "release" ? "unknown" : "not-dispatched");
    assert.equal(commits, mode === "commit" || mode === "release" ? 1 : 0);
    assert.match(result.attempt.storageKey, /^[0-9a-f]{64}$/);
  });
}

test("invalid ceilings fail before checkout", async () => {
  const ledger = new ResumeUploadReservations({ connect: async () => { throw Error("must not checkout"); } });
  for (const reservedBytes of [0, -1, 1.5, NaN, Infinity, 104857601]) {
    await assert.rejects(ledger.reserve({ ...input(), reservedBytes }), /Invalid upload reservation/);
  }
});

test("pending commit never grants or refunds; caller mutation cannot change provenance", async () => {
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>(r => { finish = r; });
  const atCommit = new Promise<void>(r => { entered = r; });
  const original = input();
  const ledger = new ResumeUploadReservations({ connect: async () => Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      if (sql === "COMMIT") { entered(); await pending; }
      return { rowCount: 1, command: sql.split(" ")[0] };
    }, release: () => {},
  }) as unknown as PoolClient });
  let settled = false;
  const result = ledger.reserve(original).then(r => { settled = true; return r; });
  await atCommit;
  original.reservedBytes = 99;
  original.clientMessageId = "mutated";
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false);
  finish();
  const done = await result;
  assert.ok(done.status === "reserved");
  assert.equal(done.attempt.reservedBytes, 10);
  assert.equal(done.attempt.clientMessageId, "key");
  assert.ok(Object.isFrozen(done.attempt));
});

for (const phase of ["BEGIN", "INSERT", "COMMIT"] as const) {
  test("checked-out client error during " + phase + " settles without an uncaught event", async () => {
    const client = Object.assign(new EventEmitter(), {
      query: async (sql: string) => {
        if (sql.startsWith(phase)) {
          client.emit("error", Error("Connection terminated unexpectedly"));
          throw Error("Connection terminated unexpectedly");
        }
        return { rowCount: 1, command: sql.split(" ")[0] };
      },
      release: (broken: boolean) => { assert.equal(broken, true); },
    });
    const unrelated = () => {};
    client.on("error", unrelated);
    const ledger = new ResumeUploadReservations({ connect: async () => client as unknown as PoolClient });
    const result = await ledger.reserve(input());
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed");
    assert.equal(result.commit, phase === "COMMIT" ? "unknown" : "not-dispatched");
    assert.deepEqual(client.listeners("error"), [unrelated]);
  });
}

test("reservation owns error event even without a pool idle listener", async () => {
  let releases = 0;
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      if (sql === "COMMIT") {
        client.emit("error", Error("lost socket"));
        throw Error("lost socket");
      }
      return { rowCount: 1, command: sql.split(" ")[0] };
    },
    release: (broken: boolean) => { releases++; assert.equal(broken, true); },
  });
  const result = await new ResumeUploadReservations({
    connect: async () => client as unknown as PoolClient,
  }).reserve(input());
  assert.ok(result.status === "failed" && result.commit === "unknown");
  assert.equal(releases, 1);
  assert.equal(client.listenerCount("error"), 0);
});


for (const acknowledgement of ["ROLLBACK", "UPDATE", undefined] as const) {
  test("non-COMMIT acknowledgement " + acknowledgement + " never reserves or rolls back again", async () => {
    const calls: string[] = [];
    let destroyed: boolean | undefined;
    const client = Object.assign(new EventEmitter(), {
      query: async (sql: string) => {
        calls.push(sql.split(" ")[0]);
        return { rowCount: 1, command: sql === "COMMIT" ? acknowledgement : sql.split(" ")[0] };
      },
      release: (broken: boolean) => { destroyed = broken; },
    });
    const result = await new ResumeUploadReservations({
      connect: async () => client as unknown as PoolClient,
    }).reserve(input());
    assert.ok(result.status === "failed" && result.commit === "unknown");
    assert.deepEqual(calls, ["BEGIN", "UPDATE", "INSERT", "COMMIT"]);
    assert.equal(destroyed, true);
    assert.equal(client.listenerCount("error"), 0);
  });
}

test("lost COMMIT ACK preserves original attempt and performs no second transaction command", async () => {
  let insertedKey: unknown;
  const calls: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql.split(" ")[0]);
      if (sql.startsWith("INSERT")) insertedKey = values?.[0];
      if (sql === "COMMIT") throw Error("lost ACK");
      return { rowCount: 1, command: sql.split(" ")[0] };
    },
    release: (broken: boolean) => assert.equal(broken, true),
  });
  const result = await new ResumeUploadReservations({
    connect: async () => client as unknown as PoolClient,
  }).reserve(input());
  assert.ok(result.status === "failed" && result.commit === "unknown");
  assert.equal(result.attempt.storageKey, insertedKey);
  assert.deepEqual(calls, ["BEGIN", "UPDATE", "INSERT", "COMMIT"]);
});

test("aborted COMMIT through reservation/storage composition consumes no body, opens no root and retains admission", async t => {
  const request = input(), bindings = new ResumeBindings();
  const binding = (await bindings.activate({ sessionId: request.sessionId, roomId: request.roomId,
    username: "Alice", authVersion: 1, generation: 1,
    issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
  "reservation-storage-test", async () => {}, () => true))!;
  const admissions = new ResumeUploadAdmissions(bindings, undefined, 10);
  const grant = admissions.admit(binding)!;
  t.after(() => { admissions.release(grant); });
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => ({ rowCount: 1,
      command: sql === "COMMIT" ? "ROLLBACK" : sql.split(" ")[0] }),
    release: (broken: boolean) => assert.equal(broken, true),
  });
  const ledger = new ResumeUploadReservations({ connect: async () => client as unknown as PoolClient });
  let io = 0, consumed = 0;
  for (const method of ["open", "mkdir"] as const) t.mock.method(fs, method, async () => {
    io++; throw Error("unexpected filesystem IO");
  });
  async function* source() { consumed++; yield Buffer.from("x"); }
  const storage = new ResumeFileStorage("/must-not-be-opened", admissions, ledger);
  await assert.rejects(storage.stage(grant, { name: "a.txt", mime: "text/plain", clientMessageId: "key" }, source()),
    /reservation denied or uncertain/);
  assert.equal(consumed, 0); assert.equal(io, 0);
  assert.equal(admissions.admit(binding), null);
  await assert.rejects(storage.stage(grant, { name: "a.txt", mime: "text/plain", clientMessageId: "key" }, source()), /denied/);
  assert.equal(consumed, 0); assert.equal(io, 0);
});
