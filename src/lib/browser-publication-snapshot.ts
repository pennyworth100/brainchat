import { validateBrowserSnapshotRow, type SnapshotRequest } from "./browser-resume-snapshot";

type Row = ReturnType<typeof validateBrowserSnapshotRow>;
export type PublicationCompletion = Readonly<{
  cut: "full-bounded-statement"; deliveryTry: string;
  history: readonly Row[]; users: readonly string[];
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Private full-cut validator. Deliberately distinct from newest100.
 * Validated data may be staged and ACKed, but neither validation nor sending an
 * ACK is durable server settlement or READY. Empty cuts have no server ACK yet.
 * No live events are mixed into the cut's exact receipt set.
 */
export function createBrowserPublicationSnapshot(request: SnapshotRequest, now = Date.now) {
  const captured = Object.freeze({ ...request }), deadline = now() + 4000;
  let completion: PublicationCompletion | null = null, closed = false;
  const cancel = () => { closed = true; completion = null; };
  const guard = () => {
    if (closed || now() >= deadline) { cancel(); throw Error("Publication snapshot closed or expired"); }
  };
  const api = Object.freeze({ request: captured,
    accept(value: unknown): PublicationCompletion {
      guard();
      try {
        if (completion || !value || typeof value !== "object" || Array.isArray(value)) {
          throw Error("Invalid publication snapshot");
        }
        const v = value as Record<string, unknown>;
        if (v.roomId !== captured.roomId || v.sessionId !== captured.sessionId ||
            v.generation !== captured.generation || v.requestId !== captured.requestId ||
            v.cut !== "full-bounded-statement" || v.window !== undefined ||
            typeof v.deliveryTry !== "string" || !uuid.test(v.deliveryTry) ||
            !Array.isArray(v.history) || v.history.length > 256 ||
            !Array.isArray(v.users) || v.users.length > 1000 ||
            !v.users.every(u => typeof u === "string" && !!u.trim() && u.length <= 64)) {
          throw Error("Invalid publication snapshot");
        }
        let previous = 0, bytes = 2;
        const history = v.history.map((item, index) => {
          const row = validateBrowserSnapshotRow(item);
          if (row.id <= previous) throw Error("Publication snapshot IDs must be ascending and unique");
          previous = row.id; bytes += encoded(row) + (index ? 1 : 0);
          if (bytes > 1024 * 1024) throw Error("Publication snapshot byte capacity");
          return row;
        });
        completion = Object.freeze({ cut: "full-bounded-statement", deliveryTry: v.deliveryTry,
          history: Object.freeze(history), users: Object.freeze([...new Set(v.users as string[])]) });
        return completion;
      } catch (error) { cancel(); throw error; }
    },
  });
  return { api, cancel,
    consume(value: PublicationCompletion) {
      guard();
      if (!completion || value !== completion) { cancel(); throw Error("Unvalidated publication snapshot"); }
      const result = completion;
      cancel();
      return Object.freeze({ snapshot: result,
        ack: Object.freeze({ deliveryTry: result.deliveryTry, ids: Object.freeze(result.history.map(row => row.id)) }) });
    },
  };
}

