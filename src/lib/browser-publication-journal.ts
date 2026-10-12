import { validateBrowserSnapshotRow, type SnapshotRequest } from "./browser-resume-snapshot";
type Row = ReturnType<typeof validateBrowserSnapshotRow>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Private memory-only projection, seeded ONLY after the controller validates
 * snapshot confirmation. ACK means retained locally, not server settlement,
 * reload durability or READY. IDs are identities, never commit watermarks.
 * No eviction: exceeding either retained bound terminates this projection.
 */
export function createBrowserPublicationJournal(request: SnapshotRequest, seed: readonly Row[]) {
  const captured = Object.freeze({ ...request });
  let rows = new Map<number, Row>(), closed = false;
  const cancel = () => { closed = true; rows.clear(); };
  const merge = (incoming: readonly unknown[]) => {
    const next = new Map(rows);
    let previous = 0;
    for (const value of incoming) {
      const row = validateBrowserSnapshotRow(value);
      if (row.id <= previous) throw Error("Journal IDs must be ascending and unique");
      previous = row.id;
      const old = next.get(row.id);
      if (old && JSON.stringify(old) !== JSON.stringify(row)) throw Error("Conflicting journal message ID");
      next.set(row.id, row);
      if (next.size > 256) throw Error("Journal retained count capacity");
    }
    const history = Object.freeze([...next.values()].sort((a, b) => a.id - b.id));
    if (new TextEncoder().encode(JSON.stringify(history)).byteLength > 1024 * 1024) {
      throw Error("Journal retained byte capacity");
    }
    rows = next;
    return history;
  };
  merge(seed);
  return { cancel, receive(value: unknown) {
    if (closed) throw Error("Journal closed");
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid journal batch");
      const v = value as Record<string, unknown>;
      if (v.roomId !== captured.roomId || v.sessionId !== captured.sessionId ||
          v.generation !== captured.generation || v.requestId !== captured.requestId ||
          v.cut !== "journal-batch" || typeof v.deliveryTry !== "string" || !uuid.test(v.deliveryTry) ||
          !Array.isArray(v.history) || v.history.length < 1 || v.history.length > 16) {
        throw Error("Invalid journal batch");
      }
      const history = merge(v.history);
      // ACK exactly this batch, including already retained duplicates. Lost ACK
      // redelivery under a NEW lease does not re-render or drop lower IDs.
      return Object.freeze({ history, ack: Object.freeze({ deliveryTry: v.deliveryTry,
        ids: Object.freeze(v.history.map(item => (item as Row).id)) }) });
    } catch (error) { cancel(); throw error; }
  } };
}

