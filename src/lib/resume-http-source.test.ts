import assert from "node:assert/strict";
import test from "node:test";
import { Agent, createServer, IncomingMessage, request as httpRequest } from "node:http";
import { connect, Socket } from "node:net";
import { once } from "node:events";
import { resumeHttpSource } from "./resume-http-source";
import { consumeResumeRequest, MAX_RESUME_BODY_CHUNK } from "./resume-request-stream";

test("HTTP source factory and iterator acquisition do not read or attach listeners", () => {
  const request = new IncomingMessage(new Socket());
  const source = resumeHttpSource(request);
  const before = request.eventNames();
  source.chunks[Symbol.asyncIterator]();
  assert.deepEqual(request.eventNames(), before);
  assert.equal(request.readableDidRead, false);
  assert.throws(() => source.chunks[Symbol.asyncIterator](), /already claimed/);
  request.destroy();
});

async function run(mode: "exact" | "disconnect" | "stall" | "sink-failure" | "slow-sink") {
  const bytes = Buffer.alloc(3 * MAX_RESUME_BODY_CHUNK + 19, 7);
  let finish!: (value: { error?: unknown; count?: number; closed: boolean; complete: boolean; delivered: number }) => void;
  const result = new Promise<Parameters<typeof finish>[0]>(r => { finish = r; });
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const server = createServer((request, response) => {
    let delivered = 0;
    const consume = async () => {
      const source = resumeHttpSource(request);
      assert.equal(request.readableDidRead, false);
      entered();
      try {
        const count = await consumeResumeRequest(source, { contentLength: bytes.length, boundary: "a" }, async (chunk, signal) => {
          assert.ok(chunk.length <= MAX_RESUME_BODY_CHUNK);
          assert.ok(chunk.every(n => n === 7));
          delivered += chunk.length;
          if (mode === "sink-failure") throw Error("sink failure");
          if (mode === "slow-sink") {
            await new Promise<void>(resolve => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
        }, mode === "stall" || mode === "slow-sink" ? 100 : 2000);
        response.end("ok");
        finish({ count, closed: request.closed, complete: request.complete, delivered });
      } catch (error) {
        finish({ error, closed: request.closed, complete: request.complete, delivered });
      }
    };
    void consume().catch(error => finish({ error, closed: request.closed, complete: request.complete, delivered }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = connect(address.port, "127.0.0.1");
  client.on("error", () => {});
  client.resume();
  try {
    await once(client, "connect");
    client.write("POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: " + bytes.length + "\r\n\r\n");
    if (mode === "disconnect" || mode === "stall") client.write(bytes.subarray(0, 17));
    else client.write(bytes);
    await started;
    if (mode === "disconnect") client.destroy();
    const outcome = await result;
    assert.equal(outcome.closed, true, "must settle after real IncomingMessage close");
    if (mode === "exact") {
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.count, bytes.length);
      assert.equal(outcome.complete, true);
    } else {
      assert.ok(outcome.error instanceof Error);
      if (mode === "stall" || mode === "slow-sink") assert.match(outcome.error.message, /deadline/);
      if (mode === "sink-failure") assert.match(outcome.error.message, /sink failure/);
    }
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
for (const mode of ["exact", "disconnect", "stall", "sink-failure", "slow-sink"] as const) {
  test("actual raw TCP HTTP body: " + mode, { timeout: 5000 }, () => run(mode));
}

test("abort before iteration observes actual close and can be repeated", async () => {
  const request = new IncomingMessage(new Socket());
  const source = resumeHttpSource(request);
  await source.abort(new Error("cancelled"));
  assert.equal(request.closed, true);
  await source.abort(new Error("again"));
  await assert.rejects(source.chunks[Symbol.asyncIterator]().next(), /not pristine/);
});

for (const mode of ["decoded", "already-read"] as const) {
  test("HTTP source fails closed for " + mode + " input", async () => {
    const request = new IncomingMessage(new Socket());
    request.push(Buffer.from("abc"));
    if (mode === "decoded") request.setEncoding("utf8");
    else request.read(1);
    const source = resumeHttpSource(request);
    await assert.rejects(source.chunks[Symbol.asyncIterator]().next(), /not pristine/);
    assert.equal(request.closed, true);
  });
}

test("early iterator return waits for request close", async () => {
  const request = new IncomingMessage(new Socket());
  request.push(Buffer.from("abc"));
  const iterator = resumeHttpSource(request).chunks[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  assert.equal((await iterator.return!()).done, true);
  assert.equal(request.closed, true);
});

test("normal body completion preserves response and HTTP keepalive", { timeout: 5000 }, async () => {
  let connections = 0;
  const server = createServer((request, response) => {
    void consumeResumeRequest(resumeHttpSource(request),
      { contentLength: 3, boundary: "a" }, async () => {}).then(() => {
      assert.equal(request.closed, true);
      response.end("accepted");
    }).catch(() => response.destroy());
  });
  server.on("connection", () => { connections++; });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (let n = 0; n < 2; n++) {
      const body = await new Promise<string>((resolve, reject) => {
        const outgoing = httpRequest({ host: "127.0.0.1", port: address.port,
          method: "POST", agent, headers: { "Content-Length": "3" } }, response => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.on("end", () => resolve(text));
          response.on("error", reject);
        });
        outgoing.on("error", reject);
        outgoing.end("abc");
      });
      assert.equal(body, "accepted");
    }
    assert.equal(connections, 1);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
