"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FormEvent,
  type DragEvent,
  type ClipboardEvent,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { isValidRoomId } from "@/lib/room-id";
import { createRoomSession, mergeMessages, type ChatMessage, type ConnectionState, type RoomSession } from "@/lib/room-session";
import { uploadRoomFile } from "@/lib/upload-client";

// ── Types ───────────────────────────────────────────────────────────────────

interface DMWindow {
  peerName: string;
  messages: { from: string; text: string; isSelf: boolean }[];
  minimized: boolean;
  unread: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string = "") {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function fmtSize(bytes: number | undefined) {
  if (!bytes) return "";
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileIcon(mime: string = "", name: string = "") {
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (/zip|rar|7z|tar|gz/.test(mime)) return "📦";
  if (mime.startsWith("text/")) return "📄";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["doc", "docx"].includes(ext)) return "📝";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["ppt", "pptx"].includes(ext)) return "📊";
  return "📎";
}

function linkify(text: string) {
  const escaped = esc(text);
  return escaped.replace(
    /(?<![="'\/\w])((?:https?:\/\/|www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s<]*)?)/g,
    (match) => {
      const href = /^https?:\/\//i.test(match) ? match : "https://" + match;
      return `<a href="${href}" target="_blank" rel="noopener" class="text-dimle-accent underline hover:text-dimle-accent-dark">${match}</a>`;
    }
  );
}

function fmtTs(ts?: number) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Components ──────────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  currentUser,
  onImageClick,
  onOpenDM,
}: {
  msg: ChatMessage;
  currentUser: string;
  onImageClick: (src: string) => void;
  onOpenDM: (name: string) => void;
}) {
  const isSelf = msg.username === currentUser;

  if (msg.type === "message") {
    return (
      <div className={`max-w-[85%] ${isSelf ? "self-end" : "self-start"}`}>
        <div
          className={`font-medium text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-accent" : "text-dimle-text-secondary cursor-pointer hover:text-dimle-accent"
          }`}
          onClick={() => !isSelf && onOpenDM(msg.username)}
          title={isSelf ? undefined : "Private message"}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-dimle-self-bg border border-dimle-border rounded-[14px_4px_14px_14px]"
              : "bg-dimle-card border border-dimle-border rounded-[4px_14px_14px_14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          }`}
        >
          <span
            className="leading-relaxed break-words text-dimle-text-primary"
            dangerouslySetInnerHTML={{ __html: linkify(msg.message || "") }}
          />
          <span className="block text-right text-[0.7rem] text-dimle-text-muted mt-1 select-none">
            {fmtTs(msg.ts)}
          </span>
        </div>
      </div>
    );
  }

  if (msg.type === "file") {
    const isImage = msg.mime?.startsWith("image/");
    return (
      <div className={`max-w-[85%] ${isSelf ? "self-end" : "self-start"}`}>
        <div
          className={`font-medium text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-accent" : "text-dimle-text-secondary cursor-pointer hover:text-dimle-accent"
          }`}
          onClick={() => !isSelf && onOpenDM(msg.username)}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-dimle-self-bg border border-dimle-border rounded-[14px_4px_14px_14px]"
              : "bg-dimle-card border border-dimle-border rounded-[4px_14px_14px_14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          }`}
        >
          {isImage ? (
            <img
              src={msg.url}
              alt={msg.name || "image"}
              className="max-w-[280px] max-h-[300px] rounded-xl cursor-pointer block"
              onClick={() => msg.url && onImageClick(msg.url)}
            />
          ) : (
            <div className="flex items-center gap-3 min-w-[200px] max-w-[280px]">
              <div className="text-2xl flex-shrink-0">
                {fileIcon(msg.mime, msg.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-dimle-text-primary truncate">
                  {msg.name}
                </div>
                <div className="text-xs text-dimle-text-muted mt-0.5">
                  {fmtSize(msg.size)}
                </div>
              </div>
              <a
                href={msg.url}
                download={msg.name}
                title="Download"
                className="flex-shrink-0 w-8 h-8 rounded-full bg-dimle-surface flex items-center justify-center text-dimle-accent hover:bg-dimle-accent-light transition-colors"
              >
                ⬇
              </a>
            </div>
          )}
          <span className="block text-right text-[0.7rem] text-dimle-text-muted mt-1 select-none">
            {fmtTs(msg.ts)}
          </span>
        </div>
      </div>
    );
  }

  if (msg.type === "image" && msg.dataUrl) {
    return (
      <div className={`max-w-[85%] ${isSelf ? "self-end" : "self-start"}`}>
        <div
          className={`font-medium text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-accent" : "text-dimle-text-secondary"
          }`}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-dimle-self-bg border border-dimle-border rounded-[14px_4px_14px_14px]"
              : "bg-dimle-card border border-dimle-border rounded-[4px_14px_14px_14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
          }`}
        >
          <img
            src={msg.dataUrl}
            alt="image"
            className="max-w-[280px] max-h-[300px] rounded-xl cursor-pointer block"
            onClick={() => msg.dataUrl && onImageClick(msg.dataUrl)}
          />
          <span className="block text-right text-[0.7rem] text-dimle-text-muted mt-1 select-none">
            {fmtTs(msg.ts)}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function DMPanel({
  dm,
  onSend,
  onToggleMinimize,
  onClose,
}: {
  dm: DMWindow;
  onSend: (peerName: string, message: string) => boolean;
  onToggleMinimize: (peerName: string) => void;
  onClose: (peerName: string) => void;
}) {
  const [input, setInput] = useState("");
  const msgRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (msgRef.current) {
      msgRef.current.scrollTop = msgRef.current.scrollHeight;
    }
  }, [dm.messages]);

  useEffect(() => {
    if (!dm.minimized && inputRef.current) {
      inputRef.current.focus();
    }
  }, [dm.minimized]);

  const doSend = () => {
    const msg = input.trim();
    if (!msg) return;
    if (onSend(dm.peerName, msg)) setInput("");
  };

  return (
    <div
      className={`w-[280px] bg-dimle-card border border-dimle-accent border-b-0 rounded-t-2xl shadow-[0_-4px_24px_rgba(0,0,0,0.08)] flex flex-col pointer-events-auto transition-[max-height] duration-200 ${
        dm.minimized ? "max-h-[40px] overflow-hidden" : "max-h-[380px]"
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-dimle-border text-sm font-semibold text-dimle-accent cursor-pointer select-none shrink-0 hover:bg-dimle-surface rounded-t-2xl transition-colors"
        onClick={() => onToggleMinimize(dm.peerName)}
      >
        <div className="flex items-center gap-1.5 flex-1 overflow-hidden">
          <span className="truncate">{dm.peerName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dm.unread > 0 && (
            <span className="bg-dimle-accent text-white text-[0.65rem] font-bold rounded-full px-1.5 min-w-[18px] text-center">
              {dm.unread}
            </span>
          )}
          <span
            className="text-dimle-text-muted hover:text-dimle-text-primary hover:bg-dimle-border rounded px-1 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize(dm.peerName);
            }}
          >
            {dm.minimized ? "+" : "−"}
          </span>
          <span
            className="text-dimle-text-muted hover:text-dimle-text-primary hover:bg-dimle-border rounded px-1 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onClose(dm.peerName);
            }}
          >
            ✕
          </span>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={msgRef}
        className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-1 text-sm"
      >
        {dm.messages.map((m, i) => (
          <div
            key={i}
            className={`px-2 py-1 rounded-lg max-w-[92%] break-words ${
              m.isSelf
                ? "bg-dimle-accent-light text-dimle-accent-dark self-end"
                : "bg-dimle-surface text-dimle-text-primary self-start"
            }`}
          >
            <div className="text-[0.65rem] text-dimle-text-muted mb-0.5">
              {m.isSelf ? `You → ${dm.peerName}` : m.from}
            </div>
            {m.text}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-1.5 px-2 py-1.5 border-t border-dimle-border shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doSend())}
          placeholder={`Message ${dm.peerName}…`}
          maxLength={500}
          className="flex-1 bg-dimle-surface border border-dimle-border rounded-xl text-dimle-text-primary px-2 py-1.5 text-sm outline-none focus:border-dimle-accent transition-colors"
        />
        <button
          onClick={doSend}
          className="bg-dimle-accent text-white rounded-xl px-2.5 py-1.5 text-xs hover:bg-dimle-accent-dark transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ── Main Room Component ─────────────────────────────────────────────────────

function RoomInner() {
  const searchParams = useSearchParams();
  const roomId = searchParams.get("id");

  const [username, setUsername] = useState<string | null>(null);
  const [usernameInput, setUsernameInput] = useState(
    "User_" + Math.floor(10 + Math.random() * 90)
  );
  const [passwordInput, setPasswordInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [msgInput, setMsgInput] = useState("");
  const [userCount, setUserCount] = useState(0);
  const [userList, setUserList] = useState<string[]>([]);
  const [showParticipants, setShowParticipants] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [dmWindows, setDmWindows] = useState<Map<string, DMWindow>>(new Map());
  const [dragOver, setDragOver] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);

  // Timeline: mixed messages and system messages
  const [timeline, setTimeline] = useState<
    (
      | { kind: "msg"; data: ChatMessage; id: number }
      | { kind: "sys"; text: string; id: number }
      | { kind: "sep"; count: number; id: number }
      | { kind: "uploading"; name: string; id: number }
    )[]
  >([]);
  const nextId = useRef(0);
  const getId = () => nextId.current++;

  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const msgInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<string | null>(null);

  // Keep usernameRef in sync
  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  // Redirect if no valid room ID
  useEffect(() => {
    if (!roomId || !isValidRoomId(roomId)) {
      window.location.href = "/";
    }
  }, [roomId]);

  // Auto-scroll
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [timeline]);

  // Reconcile snapshots and live events by server ID, including events that
  // race with a history query or the HTTP upload response.
  const receiveMessages = useCallback((incoming: ChatMessage[]) => {
    setTimeline((prev) => {
      const existing = prev.flatMap((item) => item.kind === "msg" ? [item.data] : []);
      const knownIds = new Set(existing.map((message) => message.id));
      const unseen = incoming.filter((message) => !knownIds.has(message.id));
      if (unseen.length === 0) return prev; // don't scroll on an unchanged health check
      const merged = mergeMessages(existing, unseen);
      const keys = new Map(prev.flatMap((item) => item.kind === "msg" ? [[item.data.id, item.id] as const] : []));
      const items = merged.map((data) => ({ kind: "msg" as const, data, id: keys.get(data.id) ?? getId() }));
      let index = 0;
      const timeline = prev.map((item) => item.kind === "msg" ? items[index++] : item);
      return [...timeline, ...items.slice(index)];
    });
  }, []);

  // Socket connection
  useEffect(() => {
    if (!roomId) return;
    const socket = io();
    socketRef.current = socket;
    const session = createRoomSession(socket, {
      onState: (state) => {
        setConnectionState(state);
        if (state !== "ready") {
          setShowParticipants(false);
          if (state !== "syncing") { setUserCount(0); setUserList([]); }
        }
      },
      onSnapshot: ({ history, users }) => {
        receiveMessages(history);
        setUserList(users);
        setUserCount(users.length);
      },
      onJoined: () => {
        setJoinError("");
        sessionStorage.removeItem(`dimle:creation-token:${roomId}`);
      },
      onError: (message) => {
        setJoinError(message);
        setUsername(null);
        usernameRef.current = null;
      },
    });
    sessionRef.current = session;
    const onMessage = (message: ChatMessage) => receiveMessages([message]);
    socket.on("chat-message", onMessage);
    socket.on("chat-file", onMessage);
    socket.on("chat-image", onMessage);
    const resume = () => {
      if (document.visibilityState === "visible" && usernameRef.current) {
        session.sync().catch(() => {}); // status remains reconnecting, never stale online
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    const healthTimer = window.setInterval(resume, 15_000);

    socket.on("system-message", (text: string) => {
      setTimeline((prev) => [...prev, { kind: "sys", text, id: getId() }]);
    });

    socket.on("user-count", (count: number) => setUserCount(count));
    socket.on("user-list", (users: string[]) => setUserList(users));

    // DM events
    socket.on(
      "private-message-sent",
      ({ toUsername, message }: { toUsername: string; message: string }) => {
        setDmWindows((prev) => {
          const next = new Map(prev);
          if (!next.has(toUsername)) {
            next.set(toUsername, {
              peerName: toUsername,
              messages: [],
              minimized: false,
              unread: 0,
            });
          }
          const w = { ...next.get(toUsername)! };
          w.messages = [
            ...w.messages,
            { from: "You", text: message, isSelf: true },
          ];
          next.set(toUsername, w);
          return next;
        });
      }
    );

    socket.on(
      "private-message",
      ({ fromUsername, message }: { fromUsername: string; message: string }) => {
        setDmWindows((prev) => {
          const next = new Map(prev);
          if (!next.has(fromUsername)) {
            next.set(fromUsername, {
              peerName: fromUsername,
              messages: [],
              minimized: true,
              unread: 0,
            });
          }
          const w = { ...next.get(fromUsername)! };
          w.messages = [
            ...w.messages,
            { from: fromUsername, text: message, isSelf: false },
          ];
          if (w.minimized) w.unread += 1;
          next.set(fromUsername, w);
          return next;
        });
      }
    );

    socket.on(
      "private-error",
      ({ toUsername, error }: { toUsername: string; error: string }) => {
        alert(`Cannot send DM to ${toUsername}: ${error}`);
      }
    );

    return () => {
      window.clearInterval(healthTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      session.dispose();
      sessionRef.current = null;
      socket.disconnect();
    };
  }, [roomId, receiveMessages]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const joinRoom = useCallback(() => {
    const name = usernameInput.trim() || "User_" + Math.floor(10 + Math.random() * 90);
    setUsername(name);
    usernameRef.current = name;
    if (!roomId) return;
    sessionRef.current?.join({
      roomId,
      username: name,
      password: passwordInput,
      creationToken: roomId
        ? sessionStorage.getItem(`dimle:creation-token:${roomId}`) || undefined
        : undefined,
    });
  }, [usernameInput, passwordInput, roomId]);

  const sendMessage = useCallback(async () => {
    const msg = msgInput.trim();
    const session = sessionRef.current;
    const socket = socketRef.current;
    if (!msg || !username || !session || !socket || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await session.sync();
      const result = await socket.timeout(10_000).emitWithAck("send-message", { roomId, message: msg });
      if (result.error) throw new Error(result.error);
      receiveMessages([result.message]);
      setMsgInput((current) => current === msgInput ? "" : current);
    } catch (err) {
      setTimeline((prev) => [...prev, { kind: "sys", text: err instanceof Error && err.message !== "operation has timed out"
        ? err.message : "Delivery not confirmed. Check the chat before retrying; your draft is kept.", id: getId() }]);
      session.sync().catch(() => {});
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [msgInput, username, roomId, receiveMessages]);

  const uploadFile = useCallback(
    async (file: File) => {
      const session = sessionRef.current;
      if (!username || !file || !roomId || !session) return;
      const uploadId = getId();
      setTimeline((prev) => [...prev, { kind: "uploading", name: file.name, id: uploadId }]);
      try {
        const data = await uploadRoomFile(file, roomId, session);
        // The server persists + broadcasts before returning. No second socket
        // send is needed, so a disconnect cannot strand an uploaded attachment.
        setTimeline((prev) => prev.filter((item) => item.id !== uploadId));
        receiveMessages([data.message]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "Please try again.";
        setTimeline((prev) => prev.map((item) => item.id === uploadId
          ? { kind: "sys" as const, text: `Upload failed: ${file.name} — ${reason}`, id: uploadId }
          : item));
      } finally {
        session.sync().catch(() => {});
      }
    },
    [username, roomId, receiveMessages]
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile]
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (!username) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) uploadFile(file);
          break;
        }
      }
    },
    [username, uploadFile]
  );

  const openDM = useCallback((peerName: string) => {
    setShowParticipants(false);
    setDmWindows((prev) => {
      const next = new Map(prev);
      if (next.has(peerName)) {
        const w = { ...next.get(peerName)! };
        w.minimized = false;
        w.unread = 0;
        next.set(peerName, w);
      } else {
        next.set(peerName, {
          peerName,
          messages: [],
          minimized: false,
          unread: 0,
        });
      }
      return next;
    });
  }, []);

  const sendDM = useCallback(
    (peerName: string, message: string) => {
      if (!sessionRef.current?.isReady()) {
        alert("Room is reconnecting. Please try again when connected.");
        return false;
      }
      socketRef.current?.emit("private-message", {
        roomId,
        toUsername: peerName,
        message,
      });
      return true;
    },
    [roomId]
  );

  const toggleDMMinimize = useCallback((peerName: string) => {
    setDmWindows((prev) => {
      const next = new Map(prev);
      const w = { ...next.get(peerName)! };
      w.minimized = !w.minimized;
      if (!w.minimized) w.unread = 0;
      next.set(peerName, w);
      return next;
    });
  }, []);

  const closeDM = useCallback((peerName: string) => {
    setDmWindows((prev) => {
      const next = new Map(prev);
      next.delete(peerName);
      return next;
    });
  }, []);

  if (!roomId) return null;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="room-shell flex flex-col" onPaste={handlePaste}>
      {/* Username Modal */}
      {!username && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-[100]">
          <div className="join-dialog bg-dimle-card border border-dimle-border p-8 w-[90%] text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
            <h2 className="text-xl font-bold mb-2 text-dimle-text-primary">Pick a username</h2>
            <p className="text-dimle-text-muted text-sm mb-5">
              This is how others will see you
            </p>
            <input
              type="text"
              aria-label="Username"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              maxLength={20}
              autoFocus
              className="w-full py-3 px-4 border border-dimle-border rounded-xl bg-dimle-surface text-dimle-text-primary text-center mb-3 outline-none focus:border-dimle-accent focus:ring-2 focus:ring-dimle-accent-light transition-colors"
            />
            <input
              type="password"
              aria-label="Room password (if any)"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              maxLength={256}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              placeholder="Room password (if any)"
              className="w-full py-3 px-4 border border-dimle-border rounded-xl bg-dimle-surface text-dimle-text-primary text-center mb-3 outline-none focus:border-dimle-accent focus:ring-2 focus:ring-dimle-accent-light placeholder:text-dimle-text-muted transition-colors"
            />
            <button
              onClick={joinRoom}
              className="w-full py-3 rounded-xl font-semibold text-white bg-dimle-accent hover:bg-dimle-accent-dark transition-colors"
            >
              Join Chat
            </button>
            {joinError && (
              <p className="text-red-700 text-sm mt-2">{joinError}</p>
            )}
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[300] flex items-center justify-center cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt=""
            className="max-w-[90vw] max-h-[90vh] rounded-2xl shadow-2xl"
          />
        </div>
      )}

      {/* Header */}
      <header className="room-header flex items-center justify-between px-5 py-3 bg-dimle-card border-b border-dimle-border">
        <a
          href="/"
          className="wordmark no-underline"
        >
          Dimle
        </a>
        <div className="flex items-center gap-4 text-sm text-dimle-text-secondary">
          <span>
            Room{" "}
            <span className="bg-dimle-surface px-2 py-1 rounded-lg font-mono text-dimle-text-primary">
              {roomId}
            </span>
          </span>
          <span
            className="relative cursor-pointer select-none px-2 py-1 rounded-lg hover:bg-dimle-surface transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setShowParticipants((v) => !v);
            }}
          >
            <span role="status" aria-live="polite">
              {connectionState === "ready" ? `${userCount} online` : connectionState === "syncing" ? "Syncing…" : username ? "Reconnecting…" : "Not connected"}
            </span>
            {showParticipants && (
              <div
                className="absolute top-[calc(100%+8px)] right-0 bg-dimle-card border border-dimle-border rounded-2xl p-3 min-w-[160px] max-w-[220px] z-50 shadow-[0_8px_24px_rgba(0,0,0,0.08)]"
                onClick={(e) => e.stopPropagation()}
              >
                <h4 className="text-xs text-dimle-text-muted uppercase tracking-wide mb-2">
                  Participants
                </h4>
                {userList.map((name) => {
                  const isSelf = name === username;
                  return (
                    <div
                      key={name}
                      className={`flex items-center gap-2 py-1 text-sm ${
                        isSelf
                          ? "text-dimle-accent font-semibold"
                          : "text-dimle-text-primary cursor-pointer hover:text-dimle-accent hover:bg-dimle-surface hover:rounded-lg hover:pl-1"
                      } transition-colors`}
                      onClick={() => !isSelf && openDM(name)}
                    >
                      <span className="w-[7px] h-[7px] rounded-full bg-green-500 shrink-0" />
                      <span>
                        {name}
                        {isSelf ? " (you)" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </span>
          <span className="version text-xs text-dimle-text-muted bg-dimle-surface border border-dimle-border px-2 py-0.5 rounded-full font-mono tracking-tight select-none">
            v3.0.2
          </span>
        </div>
      </header>

      <section className="room-intro"><p className="eyebrow text-dimle-accent">Your shared space</p><h1 className="room-title">The conversation.</h1></section>
      {/* Messages */}
      <div
        ref={messagesRef}
        className={`chat-timeline flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1.5 relative ${
          dragOver
            ? "after:content-['Drop_to_send'] after:fixed after:inset-0 after:bg-dimle-accent/10 after:border-[3px] after:border-dashed after:border-dimle-accent after:flex after:items-center after:justify-center after:text-xl after:font-semibold after:text-dimle-accent after:pointer-events-none after:z-[200] after:rounded-2xl"
            : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!messagesRef.current?.contains(e.relatedTarget as Node)) {
            setDragOver(false);
          }
        }}
        onDrop={handleDrop}
        onClick={() => setShowParticipants(false)}
      >
        {timeline.map((item) => {
          if (item.kind === "sep") {
            return (
              <div
                key={item.id}
                className="self-center text-dimle-text-muted text-sm py-1"
              >
                — {item.count} earlier message{item.count !== 1 ? "s" : ""} —
              </div>
            );
          }
          if (item.kind === "sys") {
            return (
              <div
                key={item.id}
                className="self-center text-dimle-text-muted text-sm py-1"
              >
                {item.text}
              </div>
            );
          }
          if (item.kind === "uploading") {
            return (
              <div key={item.id} className="max-w-[85%] self-end">
                <div className="text-right text-dimle-accent font-medium text-xs mb-0.5">
                  {username}
                </div>
                <div className="bg-dimle-self-bg border border-dimle-border rounded-[14px_4px_14px_14px] px-3.5 pt-2 pb-1.5">
                  <span className="text-dimle-text-muted text-sm italic">
                    Uploading {item.name}…
                  </span>
                </div>
              </div>
            );
          }
          if (item.kind === "msg") {
            return (
              <MessageBubble
                key={item.id}
                msg={item.data}
                currentUser={username || ""}
                onImageClick={setLightboxSrc}
                onOpenDM={openDM}
              />
            );
          }
          return null;
        })}
      </div>

      {/* Input bar */}
      <div className="chat-composer flex items-center gap-2 px-5 py-3 bg-dimle-card border-t border-dimle-border">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadFile(file);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={connectionState !== "ready"}
          title="Attach file"
          aria-label="Attach file"
          className="shrink-0 w-[42px] h-[42px] border border-dimle-border rounded-xl bg-dimle-surface text-dimle-text-secondary text-xl flex items-center justify-center hover:bg-dimle-border transition-colors"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m21 11-8 8a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8L16 5" /></svg>
        </button>
        <input
          ref={msgInputRef}
          type="text"
          aria-label="Message"
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message…"
          autoComplete="off"
          className="flex-1 py-3 px-4 border border-dimle-border rounded-xl bg-dimle-surface text-dimle-text-primary outline-none focus:border-dimle-accent focus:ring-2 focus:ring-dimle-accent-light placeholder:text-dimle-text-muted transition-colors"
        />
        <button
          onClick={sendMessage}
          disabled={connectionState !== "ready" || sending}
          className="py-3 px-6 rounded-xl font-semibold text-white bg-dimle-accent hover:bg-dimle-accent-dark transition-colors"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>

      {/* DM Panels */}
      <div className="fixed bottom-0 right-3 flex flex-row-reverse items-end gap-2.5 z-[200] pointer-events-none">
        {Array.from(dmWindows.values()).map((dm) => (
          <DMPanel
            key={dm.peerName}
            dm={dm}
            onSend={sendDM}
            onToggleMinimize={toggleDMMinimize}
            onClose={closeDM}
          />
        ))}
      </div>
    </div>
  );
}

export default function RoomPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-dimle-text-muted">
          Loading…
        </div>
      }
    >
      <RoomInner />
    </Suspense>
  );
}
