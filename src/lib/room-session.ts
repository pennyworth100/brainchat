import type { Socket } from "socket.io-client";
import { transientJoinDelay, type JoinErrorDetails } from "./join-error";

export type ConnectionState = "idle" | "reconnecting" | "syncing" | "ready" | "error";
export interface RoomCredentials {
  roomId: string;
  username: string;
  password?: string;
  creationToken?: string;
}
export interface ChatMessage {
  id: number;
  type: "message" | "file" | "image";
  username: string;
  message?: string;
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
  dataUrl?: string;
  ts: number;
}
export interface RoomSnapshot {
  history: ChatMessage[];
  users: string[];
}

// IDs are assigned by the database, not by client clocks or usernames.
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Socket.IO reconnects the transport, not our authenticated room membership. */
export function createRoomSession(
  socket: Socket,
  callbacks: {
    onState: (state: ConnectionState) => void;
    onSnapshot: (snapshot: RoomSnapshot) => void;
    onJoined: () => void;
    onError: (message: string, terminal?: boolean) => void;
  },
  timeoutMs = 10_000
) {
  let credentials: RoomCredentials | null = null;
  let state: ConnectionState = "idle";
  let disposed = false;
  let epoch = 0;
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let probe: Promise<string> | null = null;
  let healthProbe: Promise<string> | null = null;
  const waiters = new Set<{ resolve: (id: string) => void; reject: (err: Error) => void }>();
  const setState = (next: ConnectionState) => {
    state = next;
    callbacks.onState(next);
  };
  const clearJoinTimer = () => { clearTimeout(joinTimer); joinTimer = undefined; };
  const clearRetryTimer = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const rejectWaiters = (message: string) => {
    for (const waiter of waiters) waiter.reject(new Error(message));
    waiters.clear();
  };
  const restart = () => {
    if (disposed || !credentials || retryTimer || state === "error") return;
    socket.disconnect();
    socket.connect();
  };
  const onConnect = () => {
    if (!credentials || disposed || retryTimer || state === "error") return;
    const generation = ++epoch;
    setState("syncing");
    clearJoinTimer();
    joinTimer = setTimeout(() => {
      if (generation === epoch) onJoinError("Server error", { code: "SERVER_ERROR" });
    }, timeoutMs);
    // Credentials stay only in memory; never persist the room password.
    socket.emit("join-room", credentials);
  };
  const onSnapshot = (snapshot: RoomSnapshot) => {
    if (!credentials || disposed || state !== "syncing") return;
    clearJoinTimer();
    clearRetryTimer();
    retries = 0;
    callbacks.onSnapshot(snapshot);
    delete credentials.creationToken;
    callbacks.onJoined();
    setState("ready");
    if (socket.id) {
      for (const waiter of waiters) waiter.resolve(socket.id);
      waiters.clear();
    }
  };
  const onDisconnect = () => {
    ++epoch;
    clearJoinTimer();
    if (credentials && !disposed && state !== "error") setState("reconnecting");
  };
  const onJoinError = (message: string, details?: JoinErrorDetails) => {
    if (disposed || !credentials) return;
    ++epoch;
    clearJoinTimer();
    const delay = transientJoinDelay(message, details);
    if (delay !== null) {
      if (retryTimer || state === "error") return;
      if (retries < 3) {
        const backoff = 1000 * 2 ** retries++;
        setState("reconnecting");
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          restart();
        }, Math.max(delay, backoff) + Math.floor(Math.random() * 250));
        return;
      }
      // Keep credentials only in memory for an explicit Retry.
      // Even an explicit retry must not bypass the last server cooldown.
      retryTimer = setTimeout(() => { retryTimer = undefined; }, delay);
    } else {
      clearRetryTimer();
      credentials = null;
    }
    setState("error");
    callbacks.onError(message, delay === null);
    rejectWaiters(message);
  };
  const whenReady = (): Promise<string> => {
    if (disposed || !credentials) return Promise.reject(new Error("Join the room before sending"));
    if (state === "error") return Promise.reject(new Error("Connection failed. Please retry."));
    if (state === "ready" && socket.connected && socket.id) return Promise.resolve(socket.id);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (id: string) => { clearTimeout(timer); resolve(id); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Room is reconnecting. Please try again when connected."));
      }, timeoutMs * 2);
      waiters.add(waiter);
      if (!socket.connected) socket.connect();
    });
  };

  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  socket.on("connect_error", onDisconnect);
  socket.on("room-snapshot", onSnapshot);
  socket.on("join-error", onJoinError);

  // Also probes a half-open connection after iOS resumes from the file picker
  // or background. A nonzero/stale presence count is never used as readiness.
  const sync = (): Promise<string> => {
    if (probe) return probe;
    if (disposed || !credentials) return Promise.reject(new Error("Join the room before sending"));
    if (state !== "ready" || !socket.connected) return whenReady();
    const generation = epoch;
    setState("syncing");
    probe = new Promise<string>((resolve, reject) => {
      socket.timeout(timeoutMs).emit("sync-room", { roomId: credentials!.roomId },
        (err: Error | null, result?: RoomSnapshot & { error?: string }) => {
          if (disposed) return reject(new Error("Room closed"));
          if (generation !== epoch) {
            whenReady().then(resolve, reject);
          } else if (err || !result || result.error) {
            restart();
            whenReady().then(resolve, reject);
          } else {
            onSnapshot(result);
            resolve(socket.id!);
          }
        });
    }).finally(() => { probe = null; });
    return probe;
  };

  // Periodic liveness must not fetch history, announce another join, or disable
  // the editor. Foreground recovery and pre-send checks still use full sync().
  const checkHealth = (): Promise<string> => {
    if (healthProbe) return healthProbe;
    if (disposed || !credentials) return Promise.reject(new Error("Join the room before sending"));
    if (state !== "ready" || !socket.connected) return whenReady();
    const generation = epoch;
    healthProbe = new Promise<string>((resolve, reject) => {
      socket.timeout(timeoutMs).emit("sync-room", { roomId: credentials!.roomId, probeOnly: true },
        (err: Error | null, result?: { ok?: boolean; error?: string; history?: unknown; users?: unknown }) => {
          if (disposed) return reject(new Error("Room closed"));
          if (generation !== epoch) return void whenReady().then(resolve, reject);
          // Older servers return a snapshot for this event. Accept that as a
          // liveness ACK, without presenting it as another join or sync.
          const healthy = result?.ok === true || (Array.isArray(result?.history) && Array.isArray(result?.users));
          if (err || result?.error || !healthy) {
            restart();
          }
          whenReady().then(resolve, reject);
        });
    }).finally(() => { healthProbe = null; });
    return healthProbe;
  };

  return {
    join(next: RoomCredentials) {
      if (disposed) return;
      ++epoch;
      clearJoinTimer();
      clearRetryTimer();
      rejectWaiters("Room changed");
      retries = 0;
      socket.disconnect();
      credentials = { ...next };
      setState("reconnecting");
      socket.connect();
    },
    sync,
    checkHealth,
    async reconnect() {
      if (state === "error" && credentials) {
        if (retryTimer) throw new Error("Please wait before retrying the connection.");
        retries = 0;
        setState("reconnecting");
      }
      restart();
      return whenReady();
    },
    isReady: () => state === "ready" && socket.connected,
    dispose() {
      disposed = true;
      ++epoch;
      credentials = null;
      clearJoinTimer();
      clearRetryTimer();
      rejectWaiters("Room closed");
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onDisconnect);
      socket.off("room-snapshot", onSnapshot);
      socket.off("join-error", onJoinError);
    },
  };
}
export type RoomSession = ReturnType<typeof createRoomSession>;
