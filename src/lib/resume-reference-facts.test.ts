import test from "node:test";
import assert from "node:assert/strict";
import { classifyReferenceFacts } from "./resume-reference-facts";
import type { LedgerAttempt } from "./resume-ledger-inventory";
import type { ReferenceInventory, ReferenceObservation } from "./resume-reference-inventory";

const key = "a".repeat(64), other = "b".repeat(64);
const attempt: LedgerAttempt = { storage_key: key, session_id: "session", room_id: "files123",
  client_message_id: "logical", reserved_bytes: "100", created_at: "fixture", oversized: false };
const message: ReferenceObservation = { storageKey: key, messageId: 1, roomId: "files123",
  status: "reference", metadataStatus: "valid" };
const receipt = { ...message, sessionId: "session", clientMessageId: "logical" };
function facts(messages = [message], receipts: ReferenceObservation[] = [receipt], attempts = [attempt]) {
  const refs: ReferenceInventory = { messages, receipts, complete: false, parseComplete: false,
    metadataComplete: false, reasons: ["partial-fixture"] };
  const before = JSON.stringify({ attempts, refs });
  const result = classifyReferenceFacts(attempts, refs);
  assert.equal(JSON.stringify({ attempts, refs }), before);
  assert.equal(result.fullIdentity, "unobserved");
  return result.keys;
}
test("receipt join does not double-count an independent message; partial counts are facts only", () => {
  assert.deepEqual(facts()[0], { storageKey: key, attempts: 1, messages: 1, receipts: 1,
    multipleMessages: false, multipleReceipts: false, roomConflicts: 0,
    receiptIdentityConflicts: 0, comparisonsUnavailable: 0 });
});
test("duplicate messages and receipts retain independent multiplicity", () => {
  const row = facts([message, { ...message, messageId: 2 }], [receipt, { ...receipt, sessionId: "other" }])[0];
  assert.equal(row.messages, 2); assert.equal(row.receipts, 2);
  assert.equal(row.multipleMessages, true); assert.equal(row.multipleReceipts, true);
  assert.equal(row.receiptIdentityConflicts, 1);
});
test("room and logical-identity conflicts survive invalid but positive metadata", () => {
  const row = facts([{ ...message, roomId: "other123", metadataStatus: "invalid" }],
    [{ ...receipt, clientMessageId: "wrong" }])[0];
  assert.equal(row.roomConflicts, 1); assert.equal(row.receiptIdentityConflicts, 1);
});
test("truncated provenance and duplicate attempts never select a comparison winner", () => {
  for (const attempts of [[{ ...attempt, oversized: true }], [attempt, { ...attempt }]]) {
    const row = facts([message], [receipt], attempts)[0];
    assert.equal(row.comparisonsUnavailable, 2); assert.equal(row.receiptIdentityConflicts, 0);
  }
  assert.equal(facts([{ ...message, status: "oversized" }], [])[0].comparisonsUnavailable, 1);
});
test("tombstone and expired receipt do not erase surviving messages or charged attempts", () => {
  const rows = facts([message], [{ ...receipt, storageKey: null, messageId: null, status: "tombstone" }]);
  assert.equal(rows[0].messages, 1); assert.equal(rows[0].receipts, 0); assert.equal(rows[0].attempts, 1);
  assert.equal(facts([], [])[0].attempts, 1);
});
test("unknown positive keys and separately charged logical retries remain distinct", () => {
  const rows = facts([message, { ...message, storageKey: other }], [receipt]);
  assert.equal(rows[1].attempts, 0); assert.equal(rows[1].messages, 1);
  assert.equal(rows[1].comparisonsUnavailable, 1);
  const retry = facts([message], [receipt], [attempt, { ...attempt, storage_key: other }]);
  assert.equal(retry[0].receipts, 1); assert.equal(retry[1].receipts, 0);
  assert.equal(retry[1].attempts, 1); assert.equal(retry[1].receiptIdentityConflicts, 0);
});
