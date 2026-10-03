import type { Socket } from "socket.io-client";

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
    onError: (message: string) => void;
  },
  timeoutMs = 10_000
) {
  let credentials: RoomCredentials | null = null;
  let state: ConnectionState = "idle";
  let disposed = false;
  let epoch = 0;
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  let probe: Promise<string> | null = null;
  const waiters = new Set<{ resolve: (id: string) => void; reject: (err: Error) => void }>();
  const setState = (next: ConnectionState) => {
    state = next;
    callbacks.onState(next);
  };
  const clearJoinTimer = () => { clearTimeout(joinTimer); joinTimer = undefined; };
  const rejectWaiters = (message: string) => {
    for (const waiter of waiters) waiter.reject(new Error(message));
    waiters.clear();
  };
  const restart = () => {
    if (disposed || !credentials) return;
    socket.disconnect();
    socket.connect();
  };
  const onConnect = () => {
    if (!credentials || disposed) return;
    const generation = ++epoch;
    setState("syncing");
    clearJoinTimer();
    joinTimer = setTimeout(() => {
      if (generation === epoch) restart();
    }, timeoutMs);
    // Credentials stay only in memory; never persist the room password.
    socket.emit("join-room", credentials);
  };
  const onSnapshot = (snapshot: RoomSnapshot) => {
    if (!credentials || disposed) return;
    clearJoinTimer();
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
    if (credentials && !disposed) setState("reconnecting");
  };
  const onJoinError = (message: string) => {
    ++epoch;
    clearJoinTimer();
    credentials = null;
    setState("error");
    callbacks.onError(message);
    rejectWaiters(message);
  };
  const whenReady = (): Promise<string> => {
    if (disposed || !credentials) return Promise.reject(new Error("Join the room before sending"));
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

  return {
    join(next: RoomCredentials) {
      credentials = { ...next };
      if (socket.connected) onConnect();
      else { setState("reconnecting"); socket.connect(); }
    },
    sync,
    async reconnect() {
      restart();
      return whenReady();
    },
    isReady: () => state === "ready" && socket.connected,
    dispose() {
      disposed = true;
      ++epoch;
      credentials = null;
      clearJoinTimer();
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
