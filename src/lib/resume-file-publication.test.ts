import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { ResumeFilePublication } from "./resume-file-publication";
import { resumeFileContent } from "./resume-file";
const key = "a".repeat(64);
const file = { storageKey: key, name: "report.txt", size: 3, mime: "text/plain", sha256: "b".repeat(64) };
function fixture(rows: unknown[]) {
  const calls: unknown[][] = [];
  const reader = new ResumeFilePublication({ async query(...args: unknown[]) {
    calls.push(args); return { rows };
  } } as unknown as Pick<Pool, "query">);
  return { reader, calls };
}
test("publication rejects malformed keys before SQL", async () => {
  const f = fixture([]);
  for (const key of ["", "a".repeat(63), "A".repeat(64), "../blob", "a".repeat(64) + "%"]) {
    assert.equal(await f.reader.publishedFile(key), null);
  }
  assert.equal(f.calls.length, 0);
});
test("publication returns only exact canonical visible metadata and does not cache", async () => {
  const rows = [{ content: resumeFileContent(file) }], f = fixture(rows);
  assert.deepEqual(await f.reader.publishedFile(key), file);
  rows.length = 0;
  assert.equal(await f.reader.publishedFile(key), null);
  assert.equal(f.calls.length, 2);
  assert.ok(String(f.calls[0][0]).includes("LIMIT 2"));
});
test("absent, conflicting, malformed or noncanonical publications fail closed", async () => {
  const valid = resumeFileContent(file);
  const bad = [
    "{", valid + " ", valid.replace(key, "c".repeat(64)),
    valid.replace('"size":3', '"size":-1'),
    valid.replace('"sha256":"', '"sha256":"NOTHEX'),
    valid.replace('"mime":"text/plain"', '"mime":" text/plain"'),
    valid.slice(0, -1) + ',"extra":true}', " ".repeat(4097),
  ];
  for (const content of bad) assert.equal(await fixture([{ content }]).reader.publishedFile(key), null);
  assert.equal(await fixture([]).reader.publishedFile(key), null);
  assert.equal(await fixture([{ content: valid }, { content: valid }]).reader.publishedFile(key), null);
});
test("database failure never becomes a publication or cached success", async () => {
  const f = new ResumeFilePublication({ async query() { throw Error("DB unavailable"); } } as unknown as Pool);
  await assert.rejects(f.publishedFile(key), /DB unavailable/);
});
