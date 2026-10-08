const DEFAULT_POLL_MS = 1000;

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function messageText(event) {
  if (typeof event.message === "string" && event.message) return event.message;
  if (event.type === "file") return `[file: ${event.name || "attachment"}]`;
  if (event.type === "image") return "[image]";
  return `[${event.type || "event"}]`;
}

export async function pollRoomOnce({ roomId, ownUsername, client, cursorStore, dispatch }) {
  const savedCursor = await cursorStore.get(roomId);
  const events = (await client.getMessages(roomId, savedCursor ?? 0))
    .filter((event) => Number.isSafeInteger(event.id))
    .sort((left, right) => left.id - right.id);

  if (savedCursor === null) {
    const highWatermark = events.at(-1)?.id ?? 0;
    await cursorStore.set(roomId, highWatermark);
    return { bootstrapped: true, processed: 0, cursor: highWatermark };
  }

  let cursor = savedCursor;
  let processed = 0;
  for (const event of events) {
    if (event.id <= cursor) continue;
    if (event.username !== ownUsername) {
      await dispatch({ ...event, roomId, message: messageText(event) });
      processed += 1;
    }
    cursor = event.id;
    await cursorStore.set(roomId, cursor);
  }
  return { bootstrapped: false, processed, cursor };
}

export async function runDimleMonitor(options) {
  const { rooms, signal, log } = options;
  const pollMs = Math.max(500, options.pollMs || DEFAULT_POLL_MS);
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    try {
      for (const roomId of rooms) {
        if (signal.aborted) break;
        await pollRoomOnce({ ...options, roomId });
      }
      consecutiveFailures = 0;
      await wait(pollMs, signal);
    } catch (error) {
      consecutiveFailures += 1;
      log?.warn?.(`Dimle receive failed; retrying (${error instanceof Error ? error.message : String(error)})`);
      await wait(Math.min(30_000, pollMs * 2 ** Math.min(consecutiveFailures, 5)), signal);
    }
  }
}
