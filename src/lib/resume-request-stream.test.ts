import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { consumeResumeRequest as consume, MAX_RESUME_BODY_CHUNK } from "./resume-request-stream";
import { MAX_RESUME_REQUEST_BYTES } from "./resume-upload-framing";

const frame = (contentLength: number) => Object.freeze({ contentLength, boundary: "a" });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise<void>(r => setImmediate(r));
function fixture(values: Uint8Array[]) {
  let aborts = 0, returns = 0, reads = 0;
  const source = {
    chunks: { async *[Symbol.asyncIterator]() {
      try { for (const value of values) { reads++; yield value; } } finally { returns++; }
    } },
    async abort() { aborts++; },
  };
  return { source, counts: () => ({ aborts, returns, reads }) };
}

test("request stream exact length, immutable copy and serial backpressure", async () => {
  const first = Uint8Array.of(1, 2), f = fixture([first, Uint8Array.of(3)]);
  const gate = deferred(), entered = deferred();
  const received: number[][] = [];
  const result = consume(f.source, frame(3), async chunk => {
    received.push([...chunk]);
    if (received.length === 1) { entered.resolve(); await gate.promise; assert.equal(chunk[0], 1); }
  });
  await entered.promise; first[0] = 9;
  assert.equal(f.counts().reads, 1);
  gate.resolve(); assert.equal(await result, 3);
  assert.deepEqual(received, [[1, 2], [3]]);
  assert.deepEqual(f.counts(), { aborts: 0, returns: 1, reads: 2 });
});

test("request stream bounds reject before iterator acquisition", async () => {
  let reads = 0;
  const source = { chunks: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { reads++; throw Error("must not read"); } }, async abort() {} };
  for (const length of [0, -1, 1.5, NaN, Infinity, MAX_RESUME_REQUEST_BYTES + 1]) {
    await assert.rejects(consume(source, frame(length), async () => {}), /invalid request bounds/);
  }
  for (const time of [0, -1, Infinity, NaN, 30_001]) {
    await assert.rejects(consume(source, frame(1), async () => {}, time), /invalid request bounds/);
  }
  assert.equal(reads, 0);
});

test("request stream rejects early EOF and extra data without forwarding extra bytes", async () => {
  for (const [values, length, delivered] of [
    [[Uint8Array.of(1)], 2, 1],
    [[Uint8Array.of(1, 2)], 1, 0],
    [[Uint8Array.of(1), Uint8Array.of(2)], 1, 1],
  ] as const) {
    const f = fixture([...values]); let bytes = 0;
    await assert.rejects(consume(f.source, frame(length), async c => { bytes += c.length; }));
    assert.equal(bytes, delivered); assert.equal(f.counts().aborts, 1); assert.equal(f.counts().returns, 1);
  }
});

test("request stream rejects empty, non-byte and oversized chunks before sink", async () => {
  for (const chunk of [new Uint8Array(), new Uint8Array(MAX_RESUME_BODY_CHUNK + 1), "x" as unknown as Uint8Array]) {
    const f = fixture([chunk]); let writes = 0;
    await assert.rejects(consume(f.source, frame(MAX_RESUME_REQUEST_BYTES), async () => { writes++; }));
    assert.equal(writes, 0); assert.equal(f.counts().aborts, 1);
  }
  const f = fixture([new Uint8Array(MAX_RESUME_BODY_CHUNK)]);
  assert.equal(await consume(f.source, frame(MAX_RESUME_BODY_CHUNK), async () => {}), MAX_RESUME_BODY_CHUNK);
});

test("deadline aborts but holds completion until pending read AND abort settle", async () => {
  const read = deferred(), abort = deferred(), aborted = deferred();
  let returned = 0, complete = false, writes = 0;
  const source = {
    chunks: { [Symbol.asyncIterator]() { return {
      async next() { await read.promise; return { done: false, value: Uint8Array.of(1) }; },
      async return() { returned++; return { done: true as const, value: undefined }; },
    }; } },
    async abort() { aborted.resolve(); await abort.promise; },
  };
  const result = consume(source, frame(1), async () => { writes++; }, 10);
  const rejected = assert.rejects(result, /deadline/).then(() => { complete = true; });
  await aborted.promise; await tick();
  assert.equal(complete, false); assert.equal(returned, 0);
  read.resolve(); await tick();
  assert.equal(returned, 1); assert.equal(writes, 0); assert.equal(complete, false);
  abort.resolve(); await rejected;
});

test("deadline signals blocked sink but waits for sink and iterator finalization", async () => {
  const sink = deferred(), final = deferred(), aborted = deferred(), entered = deferred();
  let finalized = false, complete = false, signal: AbortSignal | undefined;
  const source = { chunks: { async *[Symbol.asyncIterator]() {
    try { yield Uint8Array.of(1); } finally { await final.promise; finalized = true; }
  } }, async abort() { aborted.resolve(); } };
  const rejected = assert.rejects(consume(source, frame(1), async (_, s) => {
    signal = s; entered.resolve(); await sink.promise;
  }, 20), /deadline/).then(() => { complete = true; });
  await entered.promise; await aborted.promise;
  assert.equal(signal?.aborted, true); assert.equal(complete, false);
  sink.resolve(); await tick(); assert.equal(finalized, false); assert.equal(complete, false);
  final.resolve(); await rejected; assert.equal(finalized, true);
});

test("deadline covers a pending successful iterator return", async () => {
  const final = deferred(), aborted = deferred();
  let read = false, complete = false;
  const source = { chunks: { [Symbol.asyncIterator]() { return {
    async next() { if (!read) { read = true; return { done: false as const, value: Uint8Array.of(1) }; } return { done: true as const, value: undefined }; },
    async return() { await final.promise; return { done: true as const, value: undefined }; },
  }; } }, async abort() { aborted.resolve(); } };
  const rejected = assert.rejects(consume(source, frame(1), async () => {}, 10), /deadline/).then(() => { complete = true; });
  await aborted.promise; assert.equal(complete, false); final.resolve(); await rejected;
});

test("source, sink, abort and finalizer failures deny without detached rejections", async () => {
  for (const where of ["source", "sink", "finalizer"]) {
    let aborts = 0, finalized = 0;
    const source = { chunks: { async *[Symbol.asyncIterator]() {
      try { if (where === "source") throw Error(where); yield Uint8Array.of(1); }
      finally { finalized++; if (where === "finalizer") throw Error(where); }
    } }, async abort() { aborts++; throw Error("abort failed"); } };
    await assert.rejects(consume(source, frame(1), async () => { if (where === "sink") throw Error(where); }), new RegExp(where));
    assert.equal(aborts, 1); assert.equal(finalized, 1);
  }
});

test("real Node Readable is destroyed and closes after body overflow", async () => {
  const stream = Readable.from([Buffer.from("ab")], { objectMode: false });
  let closed = false;
  const closure = new Promise<void>(r => stream.on("close", () => { closed = true; r(); }));
  const source = { chunks: stream, async abort() { stream.destroy(); await closure; } };
  await assert.rejects(consume(source, frame(1), async () => assert.fail("overflow reached sink")), /limit/);
  assert.equal(closed, true); assert.equal(stream.destroyed, true);
});

test("iterator return yielding again cannot report successful cleanup", async () => {
  let reads = 0, aborts = 0;
  const source = { chunks: { [Symbol.asyncIterator]() { return {
    async next() { return reads++ ? { done: true as const, value: undefined } : { done: false as const, value: Uint8Array.of(1) }; },
    async return() { return { done: false as const, value: Uint8Array.of(2) }; },
  }; } }, async abort() { aborts++; } };
  await assert.rejects(consume(source, frame(1), async () => {}), /did not close/);
  assert.equal(aborts, 1);
});

test("real stalled Node Readable deadline destroys transport before rejection", async () => {
  const stream = new Readable({ read() {} });
  let closed = false;
  const closure = new Promise<void>(r => stream.on("close", () => { closed = true; r(); }));
  const source = { chunks: stream, async abort() { stream.destroy(); await closure; } };
  await assert.rejects(consume(source, frame(1), async () => assert.fail("unexpected body"), 10), /deadline/);
  assert.equal(closed, true); assert.equal(stream.destroyed, true);
});

test("parser finish is awaited once after exact EOF, within the request operation", async () => {
  const f = fixture([Uint8Array.of(1)]);
  const entered = deferred(), release = deferred();
  let finishes = 0, complete = false;
  const pending = consume(f.source, frame(1), async () => {}, 1000, async signal => {
    finishes++; assert.equal(signal.aborted, false); entered.resolve(); await release.promise;
  }).then(value => { complete = true; return value; });
  // A separate event-loop turn detects an ignored finish hook without hanging.
  await tick();
  assert.equal(finishes, 1);
  await entered.promise; assert.equal(complete, false);
  release.resolve(); assert.equal(await pending, 1);
  assert.deepEqual(f.counts(), { aborts: 0, returns: 1, reads: 1 });
});

test("parser finish is skipped after framing length, read or write failure", async () => {
  let finishes = 0;
  const finish = async () => { finishes++; };
  for (const [values, length] of [
    [[Uint8Array.of(1)], 2], [[Uint8Array.of(1, 2)], 1],
  ] as const) {
    await assert.rejects(consume(fixture([...values]).source, frame(length), async () => {}, 1000, finish));
  }
  await assert.rejects(consume(fixture([Uint8Array.of(1)]).source, frame(1),
    async () => { throw Error("sink failed"); }, 1000, finish), /sink failed/);
  const source = { chunks: { async *[Symbol.asyncIterator]() { throw Error("read failed"); yield Uint8Array.of(1); } }, async abort() {} };
  await assert.rejects(consume(source, frame(1), async () => {}, 1000, finish), /read failed/);
  assert.equal(finishes, 0);
});

test("parser finish rejection aborts and waits for actual abort settlement", async () => {
  const f = fixture([Uint8Array.of(1)]), aborted = deferred(), release = deferred();
  let complete = false, finishes = 0;
  const source = { ...f.source, async abort() { await f.source.abort(); aborted.resolve(); await release.promise; } };
  const rejected = assert.rejects(consume(source, frame(1), async () => {}, 1000, async () => {
    finishes++; throw Error("truncated multipart");
  }), /truncated multipart/).then(() => { complete = true; });
  await aborted.promise; await tick(); assert.equal(complete, false);
  release.resolve(); await rejected;
  assert.equal(finishes, 1); assert.equal(f.counts().aborts, 1);
});

test("parser finish shares the absolute deadline and cannot settle early on abort", async () => {
  const f = fixture([Uint8Array.of(1)]), entered = deferred(), release = deferred(), aborted = deferred();
  let signal: AbortSignal | undefined, complete = false;
  const source = { ...f.source, async abort() { await f.source.abort(); aborted.resolve(); } };
  const rejected = assert.rejects(consume(source, frame(1), async () => {}, 20, async s => {
    signal = s; entered.resolve(); await release.promise;
  }), /deadline/).then(() => { complete = true; });
  await entered.promise; await aborted.promise; await tick();
  assert.equal(signal?.aborted, true); assert.equal(complete, false);
  release.resolve(); await rejected; assert.equal(f.counts().aborts, 1);
});
