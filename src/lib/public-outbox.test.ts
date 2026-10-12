import test from "node:test";
import assert from "node:assert/strict";
import { publicDraft, publicDraftSnapshot, publicOwnerScope, publicOutbox } from "./public-outbox";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(), key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); },
    removeItem: k => { values.delete(k); },
  };
}
test("identical newer edits have distinct durable revisions", () => {
  const disk = memoryStorage();
  publicDraft(disk, "scope", "same text");
  const before = publicDraftSnapshot(disk, "scope");
  publicDraft(disk, "scope", "same text");
  const after = publicDraftSnapshot(disk, "scope");
  assert.equal(before.value, after.value);
  assert.notEqual(before.revision, after.revision);
});
test("legacy drafts remain readable but cleared versioned drafts do not resurrect them", () => {
  const disk = memoryStorage();
  disk.setItem("dimle:draft:v1:scope", "legacy draft");
  assert.equal(publicDraft(disk, "scope"), "legacy draft");
  publicDraft(disk, "scope", "");
  assert.equal(publicDraft(disk, "scope"), "");
});
test("malformed versioned draft fails closed instead of falling back", () => {
  const disk = memoryStorage();
  disk.setItem("dimle:draft:v2:scope", JSON.stringify({ value: "saved", revision: null }));
  assert.throws(() => publicDraft(disk, "scope"), /invalid/);
});
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
