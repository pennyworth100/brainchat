export interface PendingPublicOperation {
  clientMessageId: string;
  kind: "text" | "file";
  payload: string | File;
  outcome: "unknown";
}

/** Tab-bound owner scope survives reload, never contains passwords or bearer grants. */
export function publicOwnerScope(storage: Storage, room: string, username: string): string {
  const key = "dimle:outbox-owner:v1";
  let owner = storage.getItem(key);
  if (!owner) { owner = crypto.randomUUID(); storage.setItem(key, owner); }
  if (storage.getItem(key) !== owner) throw Error("Browser storage is unavailable. Nothing was sent.");
  return JSON.stringify([owner, room, username]);
}

export function publicDraft(storage: Storage, scope: string, value?: string): string {
  const key = "dimle:draft:v1:" + scope;
  if (value !== undefined) {
    if (value.length > 32_768) throw Error("Draft is too long to save. Nothing was sent.");
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw Error("Draft could not be saved. Nothing was sent.");
  }
  return storage.getItem(key) ?? "";
}

/** A single uncertain operation per owner/room, no eviction, replay or implicit retry. */
export async function publicOutbox(
  scope: string, action: "read" | "reserve" | "settle", operation?: PendingPublicOperation,
  expectedId?: string, factory: IDBFactory = indexedDB,
): Promise<PendingPublicOperation | undefined> {
  if (operation?.kind === "file" && (!(operation.payload instanceof Blob) || operation.payload.size > 100 * 1024 * 1024)) {
    throw Error("Attachment cannot be saved (maximum 100 MB). Nothing was sent.");
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("dimle-public-outbox-v1", 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore("pending");
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error("Browser storage is blocked. Nothing was sent.")); };
  });
  try {
    return await new Promise<PendingPublicOperation | undefined>((resolve, reject) => {
      const tx = db.transaction("pending", action === "read" ? "readonly" : "readwrite", { durability: "strict" });
      const store = tx.objectStore("pending");
      let result: PendingPublicOperation | undefined;
      let failure: Error | undefined;
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
        result = request.result;
        if (action === "reserve") {
          if (result || !operation) {
            failure = Error("Delivery is not confirmed. Check room history; automatic retry is disabled.");
            tx.abort(); return;
          }
          // One atomic global admission decision; concurrent tabs cannot exceed it.
          const all = store.getAll();
          all.onsuccess = () => {
            try {
              const bytes = (item: PendingPublicOperation) => typeof item.payload === "string"
                ? item.payload.length * 2 : item.payload.size;
              const rows = all.result as PendingPublicOperation[];
              if (rows.length >= 8 || rows.reduce((total, row) => total + bytes(row), bytes(operation)) > 100 * 1024 * 1024) {
                failure = Error("Saved delivery storage is full. Nothing was sent."); tx.abort(); return;
              }
              result = operation;
              store.put(operation, scope);
            } catch (error) {
              failure = error instanceof Error ? error : Error("Browser storage failed. Nothing was sent.");
              tx.abort();
            }
          };
        } else if (action === "settle") {
          if (!result || result.clientMessageId !== expectedId) {
            failure = Error("Pending operation ownership changed."); tx.abort(); return;
          }
          store.delete(scope); result = undefined;
        }
        } catch (error) {
          failure = error instanceof Error ? error : Error("Browser storage failed. Nothing was sent.");
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? Error("Browser storage unavailable. Nothing was sent."));
      tx.onerror = () => { /* onabort reports transaction failure; never dispatch before complete */ };
    });
  } finally { db.close(); }
}
