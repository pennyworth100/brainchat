import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_SIZE, uploadRoomFile } from "./upload-client";

const pdf = () => new File(["%PDF-1.7\nQA\n%%EOF"], "report.pdf", { type: "application/pdf" });
const response = () => Response.json({ message: { id: 42, type: "file" } });

test("PDF upload waits for resync and uses the fresh authenticated socket ID", async () => {
  let ready = false;
  await uploadRoomFile(pdf(), "qa", {
    sync: async () => { ready = true; return "fresh-id"; },
    reconnect: async () => assert.fail("unexpected reconnect"),
  }, async (_url, options) => {
    assert.ok(ready);
    assert.equal((options!.headers as Record<string, string>)["x-socket-id"], "fresh-id");
    assert.equal(((options!.body as FormData).get("file") as File).type, "application/pdf");
    return response();
  });
});

test("401 is safely retried once with a rejoined connection; HTTP errors are explicit", async () => {
  const ids: string[] = [];
  const session = { sync: async () => "old-id", reconnect: async () => "new-id" };
  await uploadRoomFile(pdf(), "qa", session, async (_url, options) => {
    ids.push((options!.headers as Record<string, string>)["x-socket-id"]);
    return ids.length === 1 ? Response.json({ error: "Join the room" }, { status: 401 }) : response();
  });
  assert.deepEqual(ids, ["old-id", "new-id"]);
  await assert.rejects(uploadRoomFile(pdf(), "qa", session, async () => new Response("upstream body", { status: 413 })), /100 MB/);
  await assert.rejects(uploadRoomFile(pdf(), "qa", session, async () => Response.json({ error: "Too many uploads. Try again later." }, { status: 429 })), /Too many uploads/);
});

test("oversized files are rejected before networking; failed PDF does not disconnect chat", async () => {
  let syncs = 0;
  const session = { sync: async () => { syncs++; return "valid-id"; }, reconnect: async () => assert.fail("upload error must not disconnect chat") };
  await assert.rejects(uploadRoomFile({ size: MAX_FILE_SIZE + 1 } as File, "qa", session, async () => assert.fail("no HTTP for oversize")), /100 MB/);
  assert.equal(syncs, 0);
  let requests = 0;
  await assert.rejects(uploadRoomFile(pdf(), "qa", session, async () => { requests++; throw new TypeError("Failed to fetch"); }), /Network interrupted/);
  assert.equal(requests, 1, "ambiguous failure is never automatically duplicated");
  await uploadRoomFile(pdf(), "qa", session, async () => response());
});
