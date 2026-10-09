import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { inventoryUploadDatabase } from "./resume-ledger-inventory";
import { collectUploadReferences, type ReferenceInventory } from "./resume-reference-inventory";
import type { QueryResult } from "pg";

const key = "a".repeat(64);
const validMetadata = { url: `/uploads/${key}/blob`, name: "safe.txt", size: 3,
  mime: "text/plain", sha256: "b".repeat(64) };

test("receipt identity keeps independent unknowns, conflicts and private bounded inputs", async () => {
  const payload = createHash("sha256").update(JSON.stringify(["files123", "PRIVATE", "file",
    validMetadata.name, validMetadata.size, validMetadata.mime, validMetadata.sha256])).digest("hex");
  for (const [extra, expected] of [
    [{}, "match"], [{ payload_hash: "0".repeat(64) }, "conflict"],
    [{ payload_hash: "invalid" }, "unobserved"], [{ message_username: null }, "unobserved"],
    [{ message_username: "x".repeat(129) }, "unobserved"], [{ oversized: true }, "unobserved"],
    [{ content: JSON.stringify({ ...validMetadata, size: -1 }) }, "unobserved"],
  ] as const) {
    const report: ReferenceInventory = { receipts: [], messages: [], complete: false,
      parseComplete: false, metadataComplete: false, reasons: [] };
    let fetched = false;
    await collectUploadReferences(async text => ({ rows:
      text.startsWith("FETCH") && text.includes("reference_receipts") && !fetched
        ? (fetched = true, [{ message_id: 1, room_id: "files123", type: "file",
          session_id: "session", client_message_id: "retry", content: JSON.stringify(validMetadata),
          session_room_match: false, session_username_match: null, message_username: "PRIVATE",
          payload_hash: payload, ...extra }]) : [],
    } as QueryResult), { pageSize: 10, maxRows: 10 }, report);
    assert.deepEqual(report.receipts[0].identityEvidence,
      { sessionRoom: "conflict", sessionUsername: "unobserved", payloadHash: expected });
    assert.equal(report.receipts[0].storageKey, key);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  }
});
async function observe(content: string | null, extra = {}) {
  const report: ReferenceInventory = { receipts: [], messages: [], complete: false,
    parseComplete: false, metadataComplete: false, reasons: [] };
  let fetched = false;
  await collectUploadReferences(async text => ({ rows:
    text.startsWith("FETCH") && text.includes("reference_messages") && !fetched
      ? (fetched = true, [{ message_id: 1, room_id: "files123", type: "file", content, ...extra }]) : [],
  } as QueryResult), { pageSize: 10, maxRows: 10 }, report);
  return report;
}

test("canonical metadata is declared evidence only, with no raw name or body in report", async () => {
  const report = await observe(JSON.stringify(validMetadata));
  assert.equal(report.complete, true); assert.equal(report.parseComplete, true);
  assert.equal(report.metadataComplete, true);
  assert.equal(report.messages[0].metadataStatus, "valid");
  assert.equal(report.messages[0].declaredSize, 3);
  assert.equal(report.messages[0].declaredSha256, validMetadata.sha256);
  assert.ok(!JSON.stringify(report).includes("safe.txt"));
});

for (const [field, value] of Object.entries({ name: "../PRIVATE", size: -1, mime: "Text/Plain", sha256: "B".repeat(64) })) {
  test(`invalid ${field} retains positive canonical URL reference`, async () => {
    const report = await observe(JSON.stringify({ ...validMetadata, [field]: value }));
    assert.equal(report.messages[0].storageKey, key);
    assert.equal(report.messages[0].status, "reference");
    assert.equal(report.messages[0].metadataStatus, "invalid");
    assert.equal(report.messages[0].declaredSize, undefined);
    assert.equal(report.parseComplete, true); assert.equal(report.metadataComplete, false);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  });
}

test("extra fields, duplicate keys and alternate serialization are not canonical metadata", async () => {
  for (const content of [JSON.stringify({ ...validMetadata, extra: "PRIVATE" }),
    JSON.stringify(validMetadata).replace('"size":3', '"size":2,"size":3'),
    JSON.stringify(validMetadata, null, 1), JSON.stringify({ url: validMetadata.url })]) {
    const report = await observe(content);
    assert.equal(report.messages[0].storageKey, key);
    assert.equal(report.messages[0].metadataStatus, "invalid");
    assert.equal(report.metadataComplete, false);
  }
});

test("URL must match the entire canonical path, including its end boundary", async () => {
  for (const url of [validMetadata.url + "\n", validMetadata.url + "?x=1",
    "https://example.com" + validMetadata.url, validMetadata.url.replace("blob", "../blob")]) {
    const report = await observe(JSON.stringify({ ...validMetadata, url }));
    assert.equal(report.messages[0].storageKey, null);
    assert.equal(report.messages[0].metadataStatus, "invalid");
    assert.equal(report.parseComplete, false);
  }
});

test("oversized provenance never discards a bounded positive reference", async () => {
  for (const extra of [{ oversized: true }, { receipt_oversized: true }]) {
    const report = await observe(JSON.stringify(validMetadata), extra);
    assert.equal(report.messages[0].storageKey, key);
    assert.equal(report.messages[0].status, "oversized");
    assert.equal(report.messages[0].metadataStatus, "valid");
    assert.equal(report.parseComplete, false);
  }
});

test("oversized body is never parsed even if SQL cap is violated; exact byte boundary is parsed", async () => {
  const base = JSON.stringify(validMetadata);
  const boundary = base + " ".repeat(4096 - Buffer.byteLength(base));
  const exact = await observe(boundary);
  assert.equal(exact.messages[0].storageKey, key);
  assert.equal(exact.messages[0].metadataStatus, "invalid"); // noncanonical whitespace
  for (const content of [boundary + " ", JSON.stringify({ ...validMetadata, secret: "界".repeat(2000) }), null]) {
    const report = await observe(content, { oversized: true });
    assert.equal(report.messages[0].storageKey, null);
    assert.equal(report.messages[0].metadataStatus, "unobserved");
    assert.equal(report.metadataComplete, false);
  }
});

for (const failure of ["receipt-limit", "message-query"] as const) {
  test(`reference ${failure} cannot claim complete DB observation or leak driver details`, async () => {
    const statements: string[] = [], releases: boolean[] = [];
    let receipts = 0;
    const client = {
      query: async ({ text }: { text: string }) => {
        statements.push(text);
        if (text.includes("FROM resume_upload_budget")) return { rows: [{ capacity_bytes: "100", reserved_bytes: "0" }] };
        if (text.startsWith("FETCH") && text.includes("reference_receipts")) {
          if (failure === "receipt-limit" || receipts++ === 0) return { rows: [{
            session_id: "private-session", client_message_id: "retry", message_id: null, room_id: null,
          }] };
        }
        if (text.startsWith("DECLARE reference_messages")) throw Error("PRIVATE driver SQL data");
        return { rows: [] };
      },
      release: (destroy: boolean) => releases.push(destroy),
    } as unknown as PoolClient;
    const report = await inventoryUploadDatabase(client, { pageSize: 1, maxRows: 1, timeoutMs: 1000 });
    assert.equal(report.complete, false);
    assert.equal(report.accounting, "unknown");
    assert.equal(report.references?.complete, false);
    assert.equal(report.references?.parseComplete, false);
    assert.equal(report.references?.receipts.length, 1);
    assert.equal(report.references?.receipts[0].status, "tombstone");
    assert.deepEqual(report.reasons, [failure === "receipt-limit" ? "row-limit:receipts" : "db-error:references"]);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.deepEqual(releases, [true]);
    assert.equal(statements.filter(s => s === "ROLLBACK").length, 1);
    assert.equal(statements.filter(s => s.startsWith("BEGIN")).length, 1);
    if (failure === "receipt-limit") assert.ok(!statements.some(s => s.includes("DECLARE reference_messages")));
  });
}
