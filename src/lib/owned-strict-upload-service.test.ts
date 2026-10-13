import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { createOwnedStrictUploadService, type OwnedStrictUploadConfiguration } from "./owned-strict-upload-service";

const config = { host: "ledger.invalid", port: 5432, user: "ledger", password: "fixture",
  database: "ledger", clusterIdentity: "fixture", systemIdentifier: "123" };
const policy = { identity: { database: JSON.stringify(["fixture", "ledger"]), schema: "public",
  namespace: "test", quotaDomain: "volume", policyVersion: "v1", writerGeneration: "g1" },
  adapter: "resume-strict-writer-v1", layout: "provisioned-root-one-directory-one-file-v1",
  allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
  allAllocationCostsBounded: true, maxFileBytes: 6, allocationUnitBytes: 4, allocationCopies: 1,
  directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
const admissions = () => new ResumeUploadAdmissions(new ResumeBindings());
const tick = () => new Promise(r => setImmediate(r));
type Provider = Parameters<OwnedStrictUploadConfiguration["provision"]>[0];
function fixture(t: TestContext) {
  let ends = 0, releases = 0;
  t.mock.method(Pool.prototype, "connect", async () => ({
    query: async () => ({ rowCount: 1, rows: [{ database: "ledger", system_identifier: "123" }] }),
    release: () => { releases++; },
  }) as unknown as PoolClient);
  t.mock.method(Pool.prototype, "end", async () => { ends++; });
  return { get ends() { return ends; }, get releases() { return releases; } };
}
test("absent provisioning stays disabled and close retains one promise", async () => {
  const service = await createOwnedStrictUploadService({} as Pool, admissions(), null);
  assert.equal(service.downloads, null);
  const closing = service.close();
  assert.equal(service.close(), closing);
  await closing;
});
test("configured server owner fences the real provider and retains acquired lease before pool end", async t => {
  const f = fixture(t);
  let provider!: Provider, lease: any;
  const service = await createOwnedStrictUploadService({} as Pool, admissions(), { ledger: config,
    async provision(p) {
      provider = p;
      const checked = await p.checkout(p.pin(policy)!);
      assert.equal(checked.status, "acquired");
      if (checked.status === "acquired") lease = checked.lease;
      return null;
    } });
  assert.equal(service.downloads, null);
  let settled = false;
  const stop = service.close(); void stop.then(() => { settled = true; });
  assert.equal(service.close(), stop);
  assert.equal(provider.pin(policy), null);
  await tick(); assert.equal(settled, false); assert.equal(f.ends, 0);
  lease.finalize(false); await stop;
  assert.equal(f.releases, 1); assert.equal(f.ends, 1);
});
test("failed provision retains its acquired lease before reporting startup failure", async t => {
  const f = fixture(t); let lease: any;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const failure = Error("provision failed");
  const creating = createOwnedStrictUploadService({} as Pool, admissions(), { ledger: config,
    async provision(p) {
      const checked = await p.checkout(p.pin(policy)!);
      if (checked.status !== "acquired") throw Error("checkout failed");
      lease = checked.lease; entered(); throw failure;
    } });
  let settled = false;
  const rejected = assert.rejects(creating, e => e === failure).then(() => { settled = true; });
  await ready; await tick(); assert.equal(settled, false); assert.equal(f.ends, 0);
  lease.finalize(true); await rejected;
  assert.equal(f.releases, 1); assert.equal(f.ends, 1);
});
test("pool shutdown failure remains rejected on every service close", async t => {
  fixture(t);
  t.mock.method(Pool.prototype, "end", async () => { throw Error("pool end failed"); });
  const service = await createOwnedStrictUploadService({} as Pool, admissions(), {
    ledger: config, provision: () => null });
  const stop = service.close();
  await assert.rejects(stop, /settlement unconfirmed/);
  assert.equal(service.close(), stop);
  await assert.rejects(service.close(), /settlement unconfirmed/);
});
test("invalid trusted config refuses before provisioning", async () => {
  await assert.rejects(createOwnedStrictUploadService({} as Pool, admissions(), {
    ledger: { ...config, host: "" }, provision: () => assert.fail("provisioned invalid config") }), /Invalid trusted/);
});
