import { canonicalResumeFile } from "./resume-file";
import { consumeResumeRequest, MAX_RESUME_BODY_TIME_MS } from "./resume-request-stream";
import type { ResumeUploadFraming } from "./resume-upload-framing";

export const MAX_RESUME_PART_HEADERS = 8192;
type Source = Parameters<typeof consumeResumeRequest>[0];
export type ResumeMultipartSink = {
  start(metadata: Readonly<{ name: string; mime: string }>, signal: AbortSignal): Promise<void>;
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  finish(signal: AbortSignal): Promise<void>;
  // Must await all sink cleanup; NEVER refund durable liability or release admission.
  abort(reason: unknown): Promise<void>;
};

/** PRIVATE bounded, single-file grammar. Caller MUST hold authentic accounting
 * AND physical authority BEFORE calling. This parser provides neither authority
 * nor storage/DB dispatch. All callbacks are serial and awaited; finish means
 * exact request EOF, not an early multipart file-end event. Sink finish must not
 * commit/publish: the caller may do that only after this entire promise settles.
 * On failure abort settles the sink; no automatic deletion/refund/retry/release.
 */
export async function consumeResumeMultipart(source: Source, framing: ResumeUploadFraming,
  maxFileBytes: number, sink: ResumeMultipartSink, timeoutMs = MAX_RESUME_BODY_TIME_MS): Promise<number> {
  const boundary = framing.boundary;
  if (typeof boundary !== "string" || !/^[0-9A-Za-z'()+_,.\/:=?-]{1,70}$/.test(boundary) ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0 || maxFileBytes > 100 * 1024 * 1024) {
    throw Error("Invalid multipart bounds");
  }
  const frame = Object.freeze({ contentLength: framing.contentLength, boundary });
  const opening = Buffer.from("--" + boundary + "\r\n");
  const marker = Buffer.from("\r\n--" + boundary);
  let pending = Buffer.alloc(0), state: "headers" | "file" | "trailer" = "headers", size = 0;
  const write = async (bytes: Buffer, signal: AbortSignal) => {
    if (!bytes.length) return;
    if (bytes.length > maxFileBytes - size) throw Error("Multipart file limit");
    size += bytes.length;
    await sink.write(bytes, signal);
    if (signal.aborted) throw signal.reason;
  };
  try {
    await consumeResumeRequest(source, frame, async (chunk, signal) => {
      pending = Buffer.concat([pending, chunk]);
      if (state === "headers") {
        const common = Math.min(pending.length, opening.length);
        if (!pending.subarray(0, common).equals(opening.subarray(0, common))) throw Error("Invalid multipart opening");
        const end = pending.indexOf("\r\n\r\n", opening.length);
        if (end < 0) {
          if (pending.length > opening.length + MAX_RESUME_PART_HEADERS + 3) throw Error("Multipart header limit");
          return;
        }
        if (end - opening.length > MAX_RESUME_PART_HEADERS) throw Error("Multipart header limit");
        const header = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(opening.length, end));
        const lines = header.split("\r\n");
        if (lines.length !== 2) throw Error("Invalid multipart headers");
        let name: string | undefined, mime: string | undefined;
        for (const line of lines) {
          const disposition = /^Content-Disposition: form-data; name="([^"]*)"; filename="([^"\\]*)"$/i.exec(line);
          const type = /^Content-Type: ([^\r\n]+)$/i.exec(line);
          if (disposition && disposition[1] === "file" && name === undefined) name = disposition[2];
          else if (type && mime === undefined) mime = type[1];
          else throw Error("Invalid multipart headers");
        }
        const metadata = canonicalResumeFile({ name: name!, mime: mime!, size: 0,
          storageKey: "0".repeat(64), sha256: "0".repeat(64) });
        await sink.start(Object.freeze({ name: metadata.name, mime: metadata.mime }), signal);
        if (signal.aborted) throw signal.reason;
        pending = pending.subarray(end + 4);
        state = "file";
      }
      if (state === "file") {
        const end = pending.indexOf(marker);
        if (end >= 0) {
          await write(pending.subarray(0, end), signal);
          pending = pending.subarray(end + marker.length);
          state = "trailer";
        } else {
          const emit = Math.max(0, pending.length - marker.length + 1);
          await write(pending.subarray(0, emit), signal);
          pending = pending.subarray(emit);
        }
      }
      if (state === "trailer") {
        // No second part, preamble, epilogue or permissive delimiter fallback.
        const trailer = Buffer.from("--\r\n");
        if (pending.length > trailer.length || !pending.equals(trailer.subarray(0, pending.length))) {
          throw Error("Invalid multipart trailer");
        }
      }
    }, timeoutMs, async signal => {
      if (state !== "trailer" || !(pending.equals(Buffer.from("--")) ||
          pending.equals(Buffer.from("--\r\n")))) throw Error("Truncated multipart body");
      await sink.finish(signal);
    });
    return size;
  } catch (error) {
    // Request iterator and transport abort have already settled. Sink cleanup
    // can remain pending indefinitely; never race it against a refund timeout.
    await sink.abort(error);
    throw error;
  }
}
