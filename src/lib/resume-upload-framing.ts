import type { IncomingMessage } from "node:http";

export const MAX_RESUME_REQUEST_BYTES = 100 * 1024 * 1024 + 64 * 1024;
export const MAX_RESUME_HEADER_BYTES = 8192;
export const MAX_RESUME_HEADER_PAIRS = 64;
type Request = Pick<IncomingMessage, "method" | "httpVersion" | "rawHeaders">;
export type ResumeUploadFraming = Readonly<{ contentLength: number; boundary: string }>;

// PRIVATE prerequisite, not an HTTP route or bearer authorization. Read the
// original pairs: Node's normalized headers can discard duplicate Content-Type.
// Never read the body, instantiate a parser or allocate a file here. Bounds are
// application admission bounds, NOT limits on bytes already received by Node.
export function validateResumeUploadFraming(request: Request): ResumeUploadFraming | null {
  if (request.method !== "POST" || request.httpVersion !== "1.1") return null;
  const raw = request.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > MAX_RESUME_HEADER_PAIRS * 2) return null;
  let bytes = 2, length: string | undefined, type: string | undefined;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1];
    if (typeof name !== "string" || typeof value !== "string" ||
        name.length > MAX_RESUME_HEADER_BYTES || value.length > MAX_RESUME_HEADER_BYTES) return null;
    bytes += name.length + value.length + 4; // Latin-1 field bytes + ': ' + CRLF
    if (bytes > MAX_RESUME_HEADER_BYTES || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        /[^\t\x20-\x7e\x80-\xff]/.test(value)) return null;
    switch (name.toLowerCase()) {
      case "transfer-encoding": return null; // deliberately no chunked path
      case "content-length":
        if (length !== undefined) return null;
        length = value; break;
      case "content-type":
        if (type !== undefined) return null;
        type = value; break;
      case "content-encoding": return null; // no compressed envelope
      case "expect": return null; // no implicit 100-continue protocol
      case "trailer": return null;
    }
  }
  // Canonical positive decimal only; never trust a rounded JS number or CL as
  // proof of actual body length. The future stream sink must count every byte.
  if (!length || !/^[1-9][0-9]{0,8}$/.test(length) || !type) return null;
  const contentLength = Number(length);
  if (contentLength > MAX_RESUME_REQUEST_BYTES) return null;
  // Intentionally narrow RFC-compatible subset: one boundary, no extensions,
  // escapes or spaces within it; 1..70 chars. Quoted punctuation is supported.
  const match = /^multipart\/form-data[\t ]*;[\t ]*boundary=(?:([0-9A-Za-z'+_.-]{1,70})|"([0-9A-Za-z'()+_,.\/:=?-]{1,70})")[\t ]*$/i.exec(type);
  if (!match) return null;
  return Object.freeze({ contentLength, boundary: match[1] ?? match[2] });
}
