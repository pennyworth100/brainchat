import { MAX_RESUME_REQUEST_BYTES, type ResumeUploadFraming } from "./resume-upload-framing";

export const MAX_RESUME_BODY_CHUNK = 64 * 1024;
export const MAX_RESUME_BODY_TIME_MS = 30_000;
type Source = {
  chunks: AsyncIterable<Uint8Array>;
  // Trusted transport hook: stop the underlying read and await actual closure.
  // If it cannot settle, this operation MUST remain pending (no lease refund).
  abort: (reason: Error) => Promise<void>;
};

// PRIVATE prerequisite only: call AFTER framing, bearer admission and disk
// reservation. Not a multipart parser, file validator, HTTP route or lease owner.
// Sink must honor serial backpressure and settle all its work before returning.
// Optional finish runs only after exact EOF, under the SAME deadline. Use it
// for parser.end() and awaited final parser/sink work, never DB commit, publication
// or lease release. Parser file-end/onDone alone is not request completion.
// Never wrap this promise in a timeout that releases upload/disk leases.
export async function consumeResumeRequest(source: Source, framing: ResumeUploadFraming,
    write: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>,
    timeoutMs = MAX_RESUME_BODY_TIME_MS,
    finish?: (signal: AbortSignal) => Promise<void>): Promise<number> {
  const length = framing.contentLength; // snapshot before any await
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_RESUME_REQUEST_BYTES ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_RESUME_BODY_TIME_MS) {
    throw new Error("invalid request bounds");
  }
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let failure: Error | undefined;
  let abortSettled: Promise<void> | undefined;
  const fail = (reason: unknown) => {
    if (!failure) {
      failure = reason instanceof Error ? reason : new Error("request stream failed");
      controller.abort(failure);
      // Catch synchronous throw and rejection without an unhandled timer promise.
      abortSettled = Promise.resolve().then(() => source.abort(failure!)).catch(() => {});
    }
  };
  const check = () => {
    if (performance.now() >= deadline) fail(new Error("request body deadline"));
    if (failure) throw failure;
  };
  const timer = setTimeout(() => fail(new Error("request body deadline")), timeoutMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let bytes = 0;
  try {
    check();
    iterator = source.chunks[Symbol.asyncIterator]();
    for (;;) {
      check();
      const item = await iterator.next(); // never abandon a pending read
      check();
      if (item.done) {
        if (bytes !== length) throw new Error("request body truncated");
        break;
      }
      const chunk = item.value;
      // Bound before copy or sink effects. Empty chunks cannot spin microtasks.
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 ||
          chunk.byteLength > MAX_RESUME_BODY_CHUNK || chunk.byteLength > length - bytes) {
        throw new Error("request body chunk or length limit");
      }
      bytes += chunk.byteLength;
      await write(Uint8Array.from(chunk), controller.signal);
      check(); // includes time spent backpressured in the sink
    }
    // Parser finalization can emit buffered bytes or reject incomplete syntax.
    // Await real settlement; deadline cancellation does not abandon its work.
    check();
    await finish?.(controller.signal);
    check();
  } catch (error) {
    fail(error);
  } finally {
    // next/write/finish have settled before return, including after abort.
    // The deadline stays armed through finalization. No early success/refund.
    try {
      const closed = await iterator?.return?.();
      if (closed && !closed.done) fail(new Error("request iterator did not close"));
    } catch (error) { fail(error); }
    try { check(); } catch { /* failure retained */ }
    await abortSettled;
    clearTimeout(timer);
  }
  if (failure) throw failure;
  return bytes;
}
