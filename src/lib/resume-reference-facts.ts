import type { LedgerAttempt } from "./resume-ledger-inventory";
import type { ReferenceInventory } from "./resume-reference-inventory";

export type ReferenceFacts = {
  scope: "observed-storage-keys";
  fullIdentity: "unobserved";
  keys: { storageKey: string; attempts: number; messages: number; receipts: number;
    multipleMessages: boolean; multipleReceipts: boolean;
    roomConflicts: number; receiptIdentityConflicts: number;
    comparisonsUnavailable: number }[];
};

// PRIVATE, linear in the already row-bounded inventory. Counts are observations,
// never proof of absence. No winner, ownership, agreement or reclaimability flag.
// Receipt-local evidence lives in refs; session authorization/state and full
// cross-reference identity are NOT established by this aggregate.
export function classifyReferenceFacts(attempts: LedgerAttempt[], refs: ReferenceInventory): ReferenceFacts {
  const groups = new Map<string, ReferenceFacts["keys"][number]>();
  const attemptsByKey = new Map<string, LedgerAttempt[]>();
  const group = (storageKey: string) => {
    let row = groups.get(storageKey);
    if (!row) {
      row = { storageKey, attempts: 0, messages: 0, receipts: 0,
        multipleMessages: false, multipleReceipts: false, roomConflicts: 0,
        receiptIdentityConflicts: 0, comparisonsUnavailable: 0 };
      groups.set(storageKey, row);
    }
    return row;
  };
  for (const attempt of attempts) {
    group(attempt.storage_key).attempts++;
    const rows = attemptsByKey.get(attempt.storage_key) ?? [];
    rows.push(attempt); attemptsByKey.set(attempt.storage_key, rows);
  }
  for (const source of ["messages", "receipts"] as const) {
    for (const ref of refs[source]) {
      if (ref.storageKey === null) continue; // tombstones remain in source report
      const row = group(ref.storageKey);
      row[source]++;
      const candidates = attemptsByKey.get(ref.storageKey);
      // Never compare truncated provenance or select among duplicate attempts.
      if (candidates?.length !== 1 || candidates[0].oversized || ref.status === "oversized") {
        row.comparisonsUnavailable++; continue;
      }
      const attempt = candidates[0];
      if (ref.roomId === null) row.comparisonsUnavailable++;
      else if (ref.roomId !== attempt.room_id) row.roomConflicts++;
      if (source === "receipts") {
        if (ref.sessionId === undefined || ref.clientMessageId === undefined) row.comparisonsUnavailable++;
        else if (ref.sessionId !== attempt.session_id || ref.clientMessageId !== attempt.client_message_id)
          row.receiptIdentityConflicts++;
      }
    }
  }
  for (const row of groups.values()) {
    row.multipleMessages = row.messages > 1;
    row.multipleReceipts = row.receipts > 1;
  }
  return { scope: "observed-storage-keys", fullIdentity: "unobserved", keys: [...groups.values()] };
}
