import assert from "node:assert/strict";
import test from "node:test";
import { consumeResumeMultipart as consume, MAX_RESUME_PART_HEADERS, type ResumeMultipartSink } from "./resume-multipart";
const header = 'Content-Disposition: form-data; name="file"; filename="report.txt"\r\nContent-Type: text/plain';
const body = (data = "abc", headers = header, tail = "--\r\n") =>
  Buffer.from("--a\r\n" + headers + "\r\n\r\n" + data + "\r\n--a" + tail);
function fixture(chunks: Uint8Array[]) {
  let aborts = 0, closes = 0, starts = 0, finishes = 0, sinkAborts = 0, reads = 0;
  const output: Buffer[] = [];
  const metadata: unknown[] = [];
  const source = { chunks: { async *[Symbol.asyncIterator]() {
    try { for (const c of chunks) { reads++; yield c; } } finally { closes++; }
  } }, async abort() { aborts++; } };
  const sink: ResumeMultipartSink = {
    async start(m) { starts++; metadata.push(m); assert.ok(Object.isFrozen(m)); },
    async write(c) { output.push(Buffer.from(c)); },
    async finish() { finishes++; }, async abort() { sinkAborts++; },
  };
  return { source, sink, output, metadata, stats: () => ({ aborts, closes, starts, finishes, sinkAborts, reads }) };
}
const run = (f: ReturnType<typeof fixture>, length: number, limit = 1000, timeout = 30000) =>
  consume(f.source, { boundary: "a", contentLength: length }, limit, f.sink, timeout);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("every two-chunk split and bytewise framing produces the exact file only after EOF", async () => {
  const bytes = body("a\r\nb");
  for (let split = 1; split < bytes.length; split++) {
    const f = fixture([bytes.subarray(0, split), bytes.subarray(split)]);
    assert.equal(await run(f, bytes.length), 4);
    assert.equal(Buffer.concat(f.output).toString(), "a\r\nb");
    assert.deepEqual(f.metadata, [{ name: "report.txt", mime: "text/plain" }]);
    assert.deepEqual(f.stats(), { aborts: 0, closes: 1, starts: 1, finishes: 1, sinkAborts: 0, reads: 2 });
  }
  const f = fixture([...bytes].map(x => Uint8Array.of(x)));
  assert.equal(await run(f, bytes.length), 4);
  assert.equal(Buffer.concat(f.output).toString(), "a\r\nb");
});

test("empty file and optional final CRLF, unicode metadata and reversed header order", async () => {
  for (const tail of ["--", "--\r\n"]) {
    const h = 'Content-Type: text/plain\r\nContent-Disposition: form-data; name="file"; filename="zażółć.txt"';
    const bytes = body("", h, tail), f = fixture([bytes]);
    assert.equal(await run(f, bytes.length, 0), 0);
    assert.deepEqual(f.metadata, [{ name: "zażółć.txt", mime: "text/plain" }]);
  }
});

test("oversized or ambiguous headers never start storage", async () => {
  for (const headers of [
    header + "\r\nX-Extra: value", header.replace('name="file"', 'name="text"'),
    header.replace('name="file"', 'name="FILE"'),
    header.replace("report.txt", "../report.txt"), header.replace("report.txt", "bad\\name"),
    header.replace("text/plain", "text/plain; charset=utf-8"),
    header.replace("Content-Type: text/plain", "Content-Disposition: form-data; name=\"file\"; filename=\"two\""),
    "X".repeat(MAX_RESUME_PART_HEADERS + 1),
  ]) {
    const bytes = body("abc", headers), f = fixture([bytes]);
    await assert.rejects(run(f, bytes.length));
    assert.equal(f.stats().starts, 0); assert.equal(f.stats().finishes, 0);
    assert.equal(f.stats().sinkAborts, 1);
  }
  const bytes = body(); bytes[bytes.indexOf("report")] = 0xff;
  const f = fixture([bytes]); await assert.rejects(run(f, bytes.length));
  assert.equal(f.stats().starts, 0);
});

test("extra part, malformed close, truncated body and epilogue cannot finish", async () => {
  for (const bytes of [body("abc", header, "\r\n"), body("abc", header, "--\r"),
    body("abc", header, "--\r\nepilogue"), body().subarray(0, -8),
    Buffer.concat([body(), body()])]) {
    const f = fixture([bytes]); await assert.rejects(run(f, bytes.length));
    assert.equal(f.stats().finishes, 0); assert.equal(f.stats().sinkAborts, 1);
  }
});

test("file and actual request lengths are enforced before success", async () => {
  const bytes = body(), f = fixture([bytes]);
  await assert.rejects(run(f, bytes.length, 2), /file limit/);
  assert.equal(f.output.length, 0); assert.equal(f.stats().finishes, 0);
  for (const length of [bytes.length - 1, bytes.length + 1]) {
    const f = fixture([bytes]); await assert.rejects(run(f, length));
    assert.equal(f.stats().finishes, 0);
  }
});

test("multipart file-end does not finish while the request EOF remains pending", async () => {
  const bytes = body(), f = fixture([bytes]), entered = deferred(), release = deferred();
  const source = { chunks: { async *[Symbol.asyncIterator]() {
    yield bytes; entered.resolve(); await release.promise;
  } }, abort: f.source.abort };
  let settled = false;
  const pending = consume(source, { boundary: "a", contentLength: bytes.length }, 10, f.sink)
    .then(r => { settled = true; return r; });
  await entered.promise;
  assert.equal(settled, false); assert.equal(f.stats().finishes, 0);
  release.resolve(); assert.equal(await pending, 3); assert.equal(f.stats().finishes, 1);
});

test("serial sink backpressure prevents pulling another chunk", async () => {
  const bytes = body("x".repeat(100)), split = bytes.length - 6;
  const f = fixture([bytes.subarray(0, split), bytes.subarray(split)]);
  const entered = deferred(), release = deferred(), original = f.sink.write;
  f.sink.write = async (bytes, signal) => { entered.resolve(); await release.promise; await original(bytes, signal); };
  const pending = run(f, bytes.length); await entered.promise;
  assert.equal(f.stats().reads, 1); release.resolve();
  assert.equal(await pending, 100);
});

test("failure cannot settle while sink cleanup remains pending", async () => {
  const bytes = body("abc", header, "--bad"), f = fixture([bytes]);
  const entered = deferred(), release = deferred(); let settled = false;
  f.sink.abort = async () => { entered.resolve(); await release.promise; };
  const pending = run(f, bytes.length).finally(() => { settled = true; });
  const rejected = assert.rejects(pending);
  await entered.promise; assert.equal(settled, false);
  assert.equal(f.stats().closes, 1); assert.equal(f.stats().aborts, 1);
  release.resolve(); await rejected;
});

test("deadline during finish waits for real sink settlement and then abort cleanup", { timeout: 5000 }, async () => {
  const bytes = body(), f = fixture([bytes]), entered = deferred(), release = deferred(), aborted = deferred();
  let settled = false;
  f.source.abort = async () => { aborted.resolve(); };
  f.sink.finish = async () => { entered.resolve(); await release.promise; };
  const pending = run(f, bytes.length, 10, 1000).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /deadline/);
  await entered.promise; await aborted.promise; assert.equal(settled, false);
  release.resolve(); await rejected; assert.equal(f.stats().sinkAborts, 1);
});

test("invalid parser configuration never acquires source or starts sink", async () => {
  const f = fixture([body()]);
  for (const boundary of ["", "a\r\nInjected", "x".repeat(71)]) {
    await assert.rejects(consume(f.source, { boundary, contentLength: 100 }, 10, f.sink));
  }
  for (const limit of [-1, NaN, Infinity, 0.5, 100 * 1024 * 1024 + 1]) await assert.rejects(run(f, 100, limit));
  assert.equal(f.stats().reads, 0); assert.equal(f.stats().starts, 0);
});
