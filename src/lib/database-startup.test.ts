import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { prepareDatabaseStartup } from "./db/database-startup";

const inaccessible = () => ({ connect() { throw Error("Migration/SQL access forbidden"); },
  query() { throw Error("Migration/SQL access forbidden"); } }) as unknown as Pool;
test("preinstalled runtime waits for verification without accessing migration SQL", async () => {
  const runtime = inaccessible(), maintenance = inaccessible();
  let finish!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const pending = prepareDatabaseStartup(runtime, undefined,
    { maintenance, publicationTables: true, verify: () => gate }).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await pending, { maintenance, publicationTables: true });
});
test("verification rejection never falls back to runtime migrations", async () => {
  await assert.rejects(prepareDatabaseStartup(inaccessible(), undefined,
    { maintenance: inaccessible(), publicationTables: true, verify: async () => { throw Error("Fence lost"); } }), /Fence lost/);
});
test("ambiguous, absent, aliased or migration-bearing preinstalled authorities fail closed", async () => {
  const runtime = inaccessible(), maintenance = inaccessible(), migration = inaccessible();
  let calls = 0;
  const base = { maintenance, publicationTables: true as const, verify: async () => { calls++; } };
  await assert.rejects(prepareDatabaseStartup(runtime, { migrations: migration, maintenance, publicationTables: true }, base), /Ambiguous/);
  for (const bad of [{ ...base, maintenance: runtime }, { ...base, maintenance: undefined }, { ...base, verify: undefined },
    { ...base, publicationTables: false }, { ...base, migrations: migration }]) {
    await assert.rejects(prepareDatabaseStartup(runtime, undefined, bad as typeof base), /requires/);
  }
  assert.equal(calls, 0);
});
