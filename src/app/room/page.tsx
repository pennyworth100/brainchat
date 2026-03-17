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

// ── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  type: "message" | "file" | "image";
  username: string;
  message?: string;
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
  dataUrl?: string;
  ts?: number;
}

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
      return `<a href="${href}" target="_blank" rel="noopener" class="text-indigo-400 underline">${match}</a>`;
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
          className={`font-semibold text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-cyan" : "text-dimle-purple cursor-pointer"
          }`}
          onClick={() => !isSelf && onOpenDM(msg.username)}
          title={isSelf ? undefined : "Private message"}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-[#1a1a3a] border border-[#2a2a5a] rounded-[10px_0_10px_10px]"
              : "bg-dimle-card border border-dimle-border rounded-[0_10px_10px_10px]"
          }`}
        >
          <span
            className="leading-relaxed break-words"
            dangerouslySetInnerHTML={{ __html: linkify(msg.message || "") }}
          />
          <span className="block text-right text-[0.7rem] text-gray-600 mt-1 select-none">
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
          className={`font-semibold text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-cyan" : "text-dimle-purple cursor-pointer"
          }`}
          onClick={() => !isSelf && onOpenDM(msg.username)}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-[#1a1a3a] border border-[#2a2a5a] rounded-[10px_0_10px_10px]"
              : "bg-dimle-card border border-dimle-border rounded-[0_10px_10px_10px]"
          }`}
        >
          {isImage ? (
            <img
              src={msg.url}
              alt={msg.name || "image"}
              className="max-w-[280px] max-h-[300px] rounded-lg cursor-pointer block"
              onClick={() => msg.url && onImageClick(msg.url)}
            />
          ) : (
            <div className="flex items-center gap-3 min-w-[200px] max-w-[280px]">
              <div className="text-2xl flex-shrink-0">
                {fileIcon(msg.mime, msg.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-200 truncate">
                  {msg.name}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {fmtSize(msg.size)}
                </div>
              </div>
              <a
                href={msg.url}
                download={msg.name}
                title="Download"
                className="flex-shrink-0 w-8 h-8 rounded-full bg-[#2a2a4a] flex items-center justify-center text-dimle-lavender hover:bg-[#3a3a6a] transition-colors"
              >
                ⬇
              </a>
            </div>
          )}
          <span className="block text-right text-[0.7rem] text-gray-600 mt-1 select-none">
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
          className={`font-semibold text-xs mb-0.5 ${
            isSelf ? "text-right text-dimle-cyan" : "text-dimle-purple"
          }`}
        >
          {msg.username}
        </div>
        <div
          className={`px-3.5 pt-2 pb-1.5 ${
            isSelf
              ? "bg-[#1a1a3a] border border-[#2a2a5a] rounded-[10px_0_10px_10px]"
              : "bg-dimle-card border border-dimle-border rounded-[0_10px_10px_10px]"
          }`}
        >
          <img
            src={msg.dataUrl}
            alt="image"
            className="max-w-[280px] max-h-[300px] rounded-lg cursor-pointer block"
            onClick={() => msg.dataUrl && onImageClick(msg.dataUrl)}
          />
          <span className="block text-right text-[0.7rem] text-gray-600 mt-1 select-none">
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
  onSend: (peerName: string, message: string) => void;
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
    onSend(dm.peerName, msg);
    setInput("");
  };

  return (
    <div
      className={`w-[280px] bg-dimle-card border border-dimle-purple border-b-0 rounded-t-xl shadow-[0_-4px_24px_rgba(0,0,0,0.5)] flex flex-col pointer-events-auto transition-[max-height] duration-200 ${
        dm.minimized ? "max-h-[40px] overflow-hidden" : "max-h-[380px]"
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 border-b border-dimle-border-hover text-sm font-semibold text-dimle-lavender cursor-pointer select-none shrink-0 hover:bg-[#1a1a2e] rounded-t-xl"
        onClick={() => onToggleMinimize(dm.peerName)}
      >
        <div className="flex items-center gap-1.5 flex-1 overflow-hidden">
          <span className="truncate">🔒 {dm.peerName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dm.unread > 0 && (
            <span className="bg-dimle-purple text-white text-[0.65rem] font-bold rounded-full px-1.5 min-w-[18px] text-center">
              {dm.unread}
            </span>
          )}
          <span
            className="text-gray-600 hover:text-white hover:bg-[#2a2a3e] rounded px-1"
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize(dm.peerName);
            }}
          >
            {dm.minimized ? "+" : "−"}
          </span>
          <span
            className="text-gray-600 hover:text-white hover:bg-[#2a2a3e] rounded px-1"
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
            className={`px-2 py-1 rounded-md max-w-[92%] break-words ${
              m.isSelf
                ? "bg-[#2a1f4a] text-[#c4b5fd] self-end"
                : "bg-dimle-border text-gray-300 self-start"
            }`}
          >
            <div className="text-[0.65rem] text-gray-500 mb-0.5">
              {m.isSelf ? `You → ${dm.peerName}` : m.from}
            </div>
            {m.text}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-1.5 px-2 py-1.5 border-t border-dimle-border-hover shrink-0">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), doSend())}
          placeholder={`Message ${dm.peerName}…`}
          maxLength={500}
          className="flex-1 bg-dimle-border border border-dimle-border-hover rounded-lg text-white px-2 py-1.5 text-sm outline-none focus:border-dimle-purple"
        />
        <button
          onClick={doSend}
          className="bg-dimle-purple text-white rounded-lg px-2.5 py-1.5 text-xs hover:bg-dimle-purple-dark"
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [systemMessages, setSystemMessages] = useState<
    { id: number; text: string }[]
  >([]);
  const [allItems, setAllItems] = useState<
    { type: "msg"; data: ChatMessage; id: number }
    | { type: "sys"; text: string; id: number }[]
  >([]);
  const [msgInput, setMsgInput] = useState("");
  const [userCount, setUserCount] = useState(0);
  const [userList, setUserList] = useState<string[]>([]);
  const [showParticipants, setShowParticipants] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [dmWindows, setDmWindows] = useState<Map<string, DMWindow>>(new Map());
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

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
    if (!roomId || !/^\d{4}$/.test(roomId)) {
      window.location.href = "/";
    }
  }, [roomId]);

  // Auto-scroll
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [timeline]);

  // Socket connection
  useEffect(() => {
    if (!roomId) return;
    const socket = io();
    socketRef.current = socket;

    socket.on("room-info", () => {
      setJoinError("");
    });

    socket.on("join-error", (msg: string) => {
      setJoinError(msg);
      setUsername(null);
      usernameRef.current = null;
    });

    socket.on("chat-history", (history: ChatMessage[]) => {
      setTimeline((prev) => [
        ...prev,
        { kind: "sep", count: history.length, id: getId() },
        ...history.map((m) => ({
          kind: "msg" as const,
          data: m,
          id: getId(),
        })),
      ]);
    });

    socket.on(
      "chat-message",
      ({ username: sender, message }: { username: string; message: string }) => {
        setTimeline((prev) => [
          ...prev,
          {
            kind: "msg",
            data: {
              type: "message",
              username: sender,
              message,
              ts: Date.now(),
            },
            id: getId(),
          },
        ]);
      }
    );

    socket.on(
      "chat-file",
      ({
        username: sender,
        url,
        name,
        size,
        mime,
      }: {
        username: string;
        url: string;
        name: string;
        size: number;
        mime: string;
      }) => {
        // Skip if we sent it (optimistic render)
        if (sender === usernameRef.current) return;
        setTimeline((prev) => [
          ...prev,
          {
            kind: "msg",
            data: { type: "file", username: sender, url, name, size, mime, ts: Date.now() },
            id: getId(),
          },
        ]);
      }
    );

    socket.on(
      "chat-image",
      ({ username: sender, dataUrl }: { username: string; dataUrl: string }) => {
        if (sender === usernameRef.current) return;
        setTimeline((prev) => [
          ...prev,
          {
            kind: "msg",
            data: { type: "image", username: sender, dataUrl, ts: Date.now() },
            id: getId(),
          },
        ]);
      }
    );

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
      socket.disconnect();
    };
  }, [roomId]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const joinRoom = useCallback(() => {
    const name = usernameInput.trim() || "User_" + Math.floor(10 + Math.random() * 90);
    setUsername(name);
    usernameRef.current = name;
    socketRef.current?.emit("join-room", {
      roomId,
      username: name,
      password: passwordInput,
    });
  }, [usernameInput, passwordInput, roomId]);

  const sendMessage = useCallback(() => {
    const msg = msgInput.trim();
    if (!msg || !username) return;
    socketRef.current?.emit("send-message", { roomId, message: msg });
    setMsgInput("");
  }, [msgInput, username, roomId]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!username || !file) return;

      const uploadId = getId();
      setTimeline((prev) => [
        ...prev,
        { kind: "uploading", name: file.name, id: uploadId },
      ]);

      try {
        const form = new FormData();
        form.append("file", file);
        const resp = await fetch("/api/upload", { method: "POST", body: form });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        // Replace uploading indicator with real message
        setTimeline((prev) =>
          prev.map((item) =>
            item.id === uploadId
              ? {
                  kind: "msg" as const,
                  data: {
                    type: "file" as const,
                    username: username!,
                    url: data.url,
                    name: data.name,
                    size: data.size,
                    mime: data.mime,
                    ts: Date.now(),
                  },
                  id: uploadId,
                }
              : item
          )
        );

        socketRef.current?.emit("send-file", {
          roomId,
          url: data.url,
          name: data.name,
          size: data.size,
          mime: data.mime,
        });
      } catch (err) {
        setTimeline((prev) =>
          prev.map((item) =>
            item.id === uploadId
              ? { kind: "sys" as const, text: `Upload failed: ${file.name}`, id: uploadId }
              : item
          )
        );
        console.error("Upload error:", err);
      }
    },
    [username, roomId]
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
      socketRef.current?.emit("private-message", {
        roomId,
        toUsername: peerName,
        message,
      });
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
    <div className="flex flex-col h-screen" onPaste={handlePaste}>
      {/* Username Modal */}
      {!username && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]">
          <div className="bg-dimle-card border border-dimle-border rounded-xl p-8 w-[90%] max-w-[340px] text-center">
            <h2 className="text-xl font-bold mb-2">Pick a username</h2>
            <p className="text-gray-500 text-sm mb-5">
              This is how others will see you
            </p>
            <input
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              maxLength={20}
              autoFocus
              className="w-full py-3 px-4 border border-dimle-border-hover rounded-lg bg-dimle-bg text-gray-200 text-center mb-3 outline-none focus:border-dimle-purple"
            />
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && joinRoom()}
              placeholder="Room password (if any)"
              className="w-full py-3 px-4 border border-dimle-border-hover rounded-lg bg-dimle-bg text-gray-200 text-center mb-3 outline-none focus:border-dimle-purple"
            />
            <button
              onClick={joinRoom}
              className="w-full py-3 rounded-lg font-semibold text-white bg-gradient-to-br from-dimle-purple to-dimle-purple-dark hover:opacity-85 transition-opacity"
            >
              Join Chat
            </button>
            {joinError && (
              <p className="text-red-400 text-sm mt-2">{joinError}</p>
            )}
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 bg-black/[0.88] z-[300] flex items-center justify-center cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt=""
            className="max-w-[90vw] max-h-[90vh] rounded-lg"
          />
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 bg-dimle-card border-b border-dimle-border">
        <a
          href="/"
          className="font-bold text-lg bg-gradient-to-br from-dimle-purple to-dimle-cyan bg-clip-text text-transparent no-underline"
        >
          Dimle
        </a>
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>
            Room{" "}
            <span className="bg-dimle-border px-2 py-1 rounded-md font-mono text-gray-400">
              {roomId}
            </span>
          </span>
          <span
            className="relative cursor-pointer select-none px-2 py-1 rounded-md hover:bg-dimle-border transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setShowParticipants((v) => !v);
            }}
          >
            <span className="text-dimle-purple">{userCount}</span> online
            {showParticipants && (
              <div
                className="absolute top-[calc(100%+8px)] right-0 bg-dimle-card border border-dimle-border-hover rounded-xl p-3 min-w-[160px] max-w-[220px] z-50 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                onClick={(e) => e.stopPropagation()}
              >
                <h4 className="text-xs text-gray-600 uppercase tracking-wide mb-2">
                  Participants
                </h4>
                {userList.map((name) => {
                  const isSelf = name === username;
                  return (
                    <div
                      key={name}
                      className={`flex items-center gap-2 py-1 text-sm ${
                        isSelf
                          ? "text-dimle-purple font-semibold"
                          : "text-gray-300 cursor-pointer hover:text-white hover:bg-dimle-border hover:rounded-md hover:pl-1"
                      }`}
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
          <span className="text-xs text-gray-600 bg-[#1a1a2a] border border-[#2a2a3e] px-2 py-0.5 rounded-full font-mono tracking-tight select-none">
            v2.0.0
          </span>
        </div>
      </header>

      {/* Messages */}
      <div
        ref={messagesRef}
        className={`flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1.5 relative ${
          dragOver
            ? "after:content-['Drop_to_send'] after:fixed after:inset-0 after:bg-dimle-purple/20 after:border-[3px] after:border-dashed after:border-dimle-purple after:flex after:items-center after:justify-center after:text-xl after:font-semibold after:text-dimle-lavender after:pointer-events-none after:z-[200] after:rounded"
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
                className="self-center text-gray-600 text-sm py-1"
              >
                — {item.count} earlier message{item.count !== 1 ? "s" : ""} —
              </div>
            );
          }
          if (item.kind === "sys") {
            return (
              <div
                key={item.id}
                className="self-center text-gray-600 text-sm py-1"
              >
                {item.text}
              </div>
            );
          }
          if (item.kind === "uploading") {
            return (
              <div key={item.id} className="max-w-[85%] self-end">
                <div className="text-right text-dimle-cyan font-semibold text-xs mb-0.5">
                  {username}
                </div>
                <div className="bg-[#1a1a3a] border border-[#2a2a5a] rounded-[10px_0_10px_10px] px-3.5 pt-2 pb-1.5">
                  <span className="text-gray-500 text-sm italic">
                    📎 Uploading {item.name}…
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
      <div className="flex items-center gap-2 px-5 py-3 bg-dimle-card border-t border-dimle-border">
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
          title="Attach file"
          className="shrink-0 w-[42px] h-[42px] border border-[#3a3a55] rounded-lg bg-[#2a2a3d] text-dimle-lavender text-xl flex items-center justify-center hover:bg-[#3a3a55] transition-colors"
        >
          📎
        </button>
        <input
          ref={msgInputRef}
          type="text"
          value={msgInput}
          onChange={(e) => setMsgInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message…"
          autoComplete="off"
          className="flex-1 py-3 px-4 border border-dimle-border-hover rounded-lg bg-dimle-bg text-gray-200 outline-none focus:border-dimle-purple"
        />
        <button
          onClick={sendMessage}
          className="py-3 px-6 rounded-lg font-semibold text-white bg-gradient-to-br from-dimle-purple to-dimle-purple-dark hover:opacity-85 transition-opacity"
        >
          Send
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
        <div className="flex items-center justify-center h-screen text-gray-500">
          Loading…
        </div>
      }
    >
      <RoomInner />
    </Suspense>
  );
}
