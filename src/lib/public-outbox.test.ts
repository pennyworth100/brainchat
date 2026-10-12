import test from "node:test";
import assert from "node:assert/strict";
import { publicDraft, publicOwnerScope, publicOutbox } from "./public-outbox";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(), key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); },
    removeItem: k => { values.delete(k); },
  };
}
test("draft reload is scoped to exact tab owner, room and username without passwords", () => {
  const tab = memoryStorage(), disk = memoryStorage();
  const scope = publicOwnerScope(tab, "proof123", "Owner");
  publicDraft(disk, scope, "draft before reload");
  assert.equal(publicOwnerScope(tab, "proof123", "Owner"), scope);
  assert.equal(publicDraft(disk, scope), "draft before reload");
  for (const other of [
    publicOwnerScope(tab, "other123", "Owner"),
    publicOwnerScope(tab, "proof123", "Other"),
    publicOwnerScope(memoryStorage(), "proof123", "Owner"),
  ]) assert.equal(publicDraft(disk, other), "");
});
test("storage denied, silently dropped writes and over-budget drafts fail closed", () => {
  const denied = memoryStorage();
  denied.setItem = () => { throw new DOMException("Denied", "SecurityError"); };
  assert.throws(() => publicOwnerScope(denied, "proof123", "Owner"), /Denied/);
  assert.throws(() => publicDraft(denied, "scope", "draft"), /Denied/);
  const dropped = memoryStorage(); dropped.setItem = () => {};
  assert.throws(() => publicOwnerScope(dropped, "proof123", "Owner"), /unavailable/);
  assert.throws(() => publicDraft(dropped, "scope", "draft"), /could not be saved/);
  const disk = memoryStorage(); publicDraft(disk, "scope", "retained");
  assert.throws(() => publicDraft(disk, "scope", "x".repeat(32769)), /too long/);
  assert.equal(publicDraft(disk, "scope"), "retained");
});
test("unavailable IndexedDB rejects instead of acknowledging reservation", async () => {
  const denied = { open() { throw Error("Denied"); } } as unknown as IDBFactory;
  await assert.rejects(publicOutbox("scope", "reserve", {
    kind: "text", payload: "saved payload", clientMessageId: crypto.randomUUID(), outcome: "unknown",
  }, undefined, denied), /Denied/);
});

