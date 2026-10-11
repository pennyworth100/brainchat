import type { IncomingMessage } from "node:http";
import { MAX_RESUME_BODY_CHUNK } from "./resume-request-stream";

// PRIVATE, single-consumer transport only. The caller must admit framing,
// bearer and disk reservation BEFORE starting iteration. Factory is dormant.
// This bounds delivered slices, NOT Node/socket buffers or multipart parsing.
export function resumeHttpSource(request: IncomingMessage) {
  let claimed = false;
  let closure: Promise<void> | undefined;
  const observe = () => {
    if (!closure) {
      closure = new Promise<void>(resolve => {
        if (request.closed) { resolve(); return; }
        // Keep an error listener until actual close, including abort-before-read.
        const error = () => {};
        request.on("error", error);
        request.once("close", () => {
          request.off("error", error);
          resolve();
        });
      });
    }
    return closure;
  };
  return {
    chunks: {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        if (claimed) throw new Error("request source already claimed");
        claimed = true;
        return (async function* () {
          const closed = observe();
          try {
            if (request.readableEncoding || request.readableDidRead ||
                request.readableFlowing === true || request.destroyed) {
              throw new Error("request source is not pristine");
            }
            // Native iterator handles premature EOF/error and backpressure.
            // Split potentially coalesced native buffers without copying them.
            for await (const chunk of request) {
              if (!(chunk instanceof Uint8Array)) throw new Error("non-byte request body");
              for (let offset = 0; offset < chunk.byteLength; offset += MAX_RESUME_BODY_CHUNK) {
                yield chunk.subarray(offset, offset + MAX_RESUME_BODY_CHUNK);
              }
            }
            if (!request.complete || !request.readableEnded) throw new Error("incomplete HTTP request");
          } finally {
            // Early return, sink failure and abort all require actual close.
            // Normal EOF auto-destroys IncomingMessage, not the keepalive socket.
            if (!request.readableEnded && !request.destroyed) request.destroy();
            await closed;
          }
        })();
      },
    },
    async abort(reason: Error): Promise<void> {
      const closed = observe();
      request.destroy(reason);
      await closed;
    },
  };
}
