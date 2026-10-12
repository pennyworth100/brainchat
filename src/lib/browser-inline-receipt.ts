import type { createBrowserResumeController } from "./browser-resume-controller";

type Controller = ReturnType<typeof createBrowserResumeController>;
type Operation = ReturnType<Controller["beginOperation"]>;

// Browser-safe counterpart of the server canonical image input. Differential
// tests keep it aligned; no server/crypto/Buffer imports in the browser bundle.
export function canonicalBrowserInline(kind: "message" | "image", payload: string): string {
  if (typeof payload !== "string") throw Error("Invalid inline payload");
  if (kind === "message") {
    if (!payload.trim() || payload.length > 10_000) throw Error("Invalid inline payload");
    return payload;
  }
  if (kind !== "image" || payload.length > 12 * 1024 * 1024) throw Error("Invalid inline payload");
  const comma = payload.indexOf(","), header = payload.slice(0, comma).toLowerCase();
  const encoded = payload.slice(comma + 1);
  if (!/^data:image\/(?:png|jpeg|gif|webp);base64$/.test(header) ||
      !encoded || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) {
    throw Error("Invalid inline payload");
  }
  if (btoa(atob(encoded)) !== encoded) throw Error("Invalid inline payload");
  return header + "," + encoded;
}

export async function browserInlineHash(roomId: string, username: string,
  kind: "message" | "image", payload: string): Promise<string> {
  const canonical = canonicalBrowserInline(kind, payload);
  const bytes = new TextEncoder().encode(JSON.stringify([roomId, username, kind, canonical]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid inline receipt");
  return value as Record<string, unknown>;
};

/** Private request-local adapter for the ACTUAL ResumeSendReply wire shape.
 * Caller binds accept ONLY to this request ACK on the authenticated connection,
 * never to broadcasts/history or arbitrary HTTP input. Local validation is NOT
 * authentication. No invented server hash/session fields and no file fallback.
 * No network effects, automatic retry, public wiring or payload durability. */
export function createBrowserInlineReceiptAdapter(controller: Controller,
  operation: Operation, physical: object, payload: string) {
  if (operation.kind === "file") throw Error("File receipt requires byte identity contract");
  const kind = operation.kind;
  const canonical = canonicalBrowserInline(kind, payload);
  // Capture exact logical AND physical dispatch before any asynchronous digest.
  const sent = controller.dispatch(operation, physical);
  const request = Object.freeze({ roomId: sent.roomId, clientMessageId: sent.clientMessageId,
    ...(kind === "message" ? { message: canonical } : { dataUrl: canonical }) });
  return Object.freeze({ request, async accept(value: unknown) {
    const reply = record(value), message = record(reply.message);
    // Snapshot all scalars before await. Never trust echoed payloadHash/sessionId.
    const id = message.id, content = kind === "message" ? message.message : message.dataUrl;
    if ("error" in reply || reply.clientMessageId !== sent.clientMessageId ||
        message.type !== kind || message.username !== sent.username ||
        !Number.isSafeInteger(id) || (id as number) < 1 ||
        typeof message.ts !== "number" || !Number.isFinite(message.ts) ||
        typeof content !== "string" || content !== canonical) throw Error("Inline receipt mismatch");
    const hash = await browserInlineHash(sent.roomId, sent.username, kind, content);
    if (hash !== sent.payloadHash) throw Error("Inline payload identity mismatch");
    // Recheck owner/phase/expiry/physical identity AFTER the asynchronous digest.
    return controller.reconcile(operation, physical, { sessionId: sent.sessionId,
      clientMessageId: sent.clientMessageId, kind, payloadHash: hash, messageId: id as number });
  } });
}
