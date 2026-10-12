import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { MAX_RESUME_HEADER_BYTES, MAX_RESUME_HEADER_PAIRS, MAX_RESUME_REQUEST_BYTES,
  validateResumeUploadFraming as validate } from "./resume-upload-framing";

const headers = () => ["Content-Length", "123", "Content-Type", "multipart/form-data; boundary=----WebKit_Ab9"];
const check = (rawHeaders: string[]) => validate({ method: "POST", httpVersion: "1.1", rawHeaders });

test("framing accepts canonical browser envelope and freezes its snapshot", () => {
  const raw = headers(), result = check(raw);
  assert.deepEqual(result, { contentLength: 123, boundary: "----WebKit_Ab9" });
  assert.ok(Object.isFrozen(result)); raw[1] = "456";
  assert.equal(result?.contentLength, 123);
  assert.equal(check(["content-length", "1", "CONTENT-TYPE", 'Multipart/Form-Data; boundary="a:b/c=?"'])?.boundary, "a:b/c=?");
});

test("framing denies duplicate, combined, missing and ambiguous lengths", () => {
  for (const value of ["", "0", "00", "01", "-1", "+1", "1.0", "1e2", "1, 1", " 1", "1 ", "9007199254740993", String(MAX_RESUME_REQUEST_BYTES + 1)]) {
    const raw = headers(); raw[1] = value; assert.equal(check(raw), null, value);
  }
  assert.equal(check([...headers(), "cOnTeNt-LeNgTh", "123"]), null);
  assert.equal(check(headers().slice(2)), null);
  const raw = headers(); raw[1] = String(MAX_RESUME_REQUEST_BYTES);
  assert.equal(check(raw)?.contentLength, MAX_RESUME_REQUEST_BYTES);
});

test("framing denies transfer coding, compressed bodies, trailers and expect", () => {
  for (const name of ["Transfer-Encoding", "Content-Encoding", "Expect", "Trailer"]) {
    for (const value of ["", "chunked", "identity", "100-continue"]) {
      assert.equal(check([...headers(), name, value]), null, `${name}: ${value}`);
    }
  }
});

test("framing requires one strictly bounded multipart boundary", () => {
  for (const value of ["text/plain", "multipart/form-data", "multipart/mixed; boundary=a", "multipart/form-data; boundary=", "multipart/form-data; boundary=a; boundary=b", "multipart/form-data; boundary=a; charset=utf-8", 'multipart/form-data; boundary="a b"', 'multipart/form-data; boundary="a\\b"', "multipart/form-data; boundary=a:b", `multipart/form-data; boundary=${"a".repeat(71)}`]) {
    const raw = headers(); raw[3] = value; assert.equal(check(raw), null, value);
  }
  assert.equal(check([...headers(), "content-type", headers()[3]]), null);
  assert.equal(check(headers().slice(0, 2)), null);
  const raw = headers(); raw[3] = `multipart/form-data; boundary=${"a".repeat(70)}`;
  assert.equal(check(raw)?.boundary.length, 70);
});

test("framing bounds all header pairs and bytes, including unrelated headers", () => {
  const raw = headers();
  for (let i = 2; i < MAX_RESUME_HEADER_PAIRS; i++) raw.push("X", "a");
  assert.ok(check(raw)); assert.equal(check([...raw, "X", "a"]), null);
  const base = headers(), used = 2 + base.reduce((sum, s) => sum + s.length, 0) + 4 * 2;
  const exact = [...base, "X", "a".repeat(MAX_RESUME_HEADER_BYTES - used - 5)];
  assert.ok(check(exact)); exact[5] += "a"; assert.equal(check(exact), null);
  for (const pair of [["Bad Name", "x"], ["X", "a\r\nb"], ["X", "\0"], ["X", "\u0100"]]) assert.equal(check([...base, ...pair]), null);
  assert.equal(check([...base, "odd"]), null);
});

test("framing rejects unsupported method and HTTP versions without consuming a body", () => {
  for (const method of ["GET", "PUT", undefined]) assert.equal(validate({ method, httpVersion: "1.1", rawHeaders: headers() }), null);
  for (const httpVersion of ["1.0", "2.0", ""]) assert.equal(validate({ method: "POST", httpVersion, rawHeaders: headers() }), null);
});

test("real Node rawHeaders expose duplicate Content-Type discarded by normalized headers", async t => {
  let admitted = 0, seen = 0;
  const server = http.createServer(request => {
    seen++;
    assert.equal(request.headers["content-type"], "multipart/form-data; boundary=a");
    if (validate(request)) admitted++;
    request.socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1", () => {
      socket.write("POST /private-fixture HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\nContent-Type: multipart/form-data; boundary=a\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nx");
    });
    socket.setTimeout(2000, () => { socket.destroy(); reject(Error("fixture timeout")); });
    socket.on("data", () => {}); socket.on("error", reject); socket.on("close", () => resolve());
  });
  assert.equal(seen, 1); assert.equal(admitted, 0);
});
