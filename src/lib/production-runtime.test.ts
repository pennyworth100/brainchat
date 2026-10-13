import test from "node:test";
import assert from "node:assert/strict";
import { startProductionRuntime } from "../../production-runtime";

test("production runtime rejects missing live verifier before environment or CA access", async () => {
  const environment = new Proxy({}, { get() { throw Error("environment was read"); } });
  await assert.rejects(startProductionRuntime({ environment, ca: "not-a-certificate",
    verify: undefined as unknown as () => Promise<{assertHeld: () => Promise<void>}> }), /Live production verifier required/);
});

test("production runtime rejects invalid configuration without calling the controller", async () => {
  let called = false;
  await assert.rejects(startProductionRuntime({ environment: {}, ca: "not-a-certificate",
    verify: async () => { called = true; return {assertHeld: async () => {}}; } }), /Production CA certificate required/);
  assert.equal(called, false);
});
