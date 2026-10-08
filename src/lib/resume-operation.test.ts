import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";

test("uncertain COMMIT throws, destroys checkout and never returns authorization", async () => {
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({
    sessionId: "fixture", roomId: "candy986", username: "Guest", authVersion: 1,
    generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  }, "transport_A_123456", async () => {}, () => true);
  assert.ok(binding);
  const commands: string[] = [];
  let destroyed = false;
  const client = {
    query: async (sql: string) => {
      commands.push(sql);
      if (sql === "COMMIT") throw new Error("uncertain commit");
      return { rowCount: 1, rows: [{ id: "fixture" }] };
    },
    release: (error: boolean) => { destroyed = error; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, "connect">;
  await assert.rejects(new ResumeOperationGate(pool, bindings).run(binding,
    async tx => { await tx.query("INSERT fixture"); return "must not escape"; }), /uncertain commit/);
  assert.equal(destroyed, true);
  assert.equal(commands.at(-1), "ROLLBACK");
  assert.ok(commands.indexOf("INSERT fixture") < commands.indexOf("COMMIT"));
});

test("disconnect while waiting for checkout prevents callback inside transaction", async () => {
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({
    sessionId: "fixture", roomId: "candy986", username: "Guest", authVersion: 1,
    generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  }, "transport_A_123456", async () => {}, () => true);
  assert.ok(binding);
  const commands: string[] = [];
  const client = {
    query: async (sql: string) => { commands.push(sql); return { rowCount: 1 }; },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => { bindings.detach(binding); return client; } } as Pick<Pool, "connect">;
  const result = await new ResumeOperationGate(pool, bindings).run(binding,
    async () => { assert.fail("disconnected work must not execute"); });
  assert.deepEqual(result, { authorized: false });
  assert.equal(commands.at(-1), "ROLLBACK");
  assert.equal(commands.includes("COMMIT"), false);
});
