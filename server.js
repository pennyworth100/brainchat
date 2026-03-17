const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");
const multer  = require("multer");
const crypto  = require("crypto");
const fs      = require("fs");
const { eq, desc, gt } = require("drizzle-orm");
const { db }  = require("./db");
const { rooms: roomsTable, messages: messagesTable } = require("./db/schema");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT       = process.env.PORT || 3000;
const MAX_HISTORY = 100;
const ALFRED_API_KEY = process.env.ALFRED_API_KEY || "alfred-secret";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/dimle-uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory: online users per room (transient socket state only)
// Map<roomId, Map<socketId, username>>
const onlineUsers = new Map();

function getOrCreateOnlineRoom(roomId) {
  if (!onlineUsers.has(roomId)) onlineUsers.set(roomId, new Map());
  return onlineUsers.get(roomId);
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function ensureRoom(roomId, password) {
  const existing = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId)).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(roomsTable).values({
    id: roomId,
    passwordHash: password || null,
  }).returning();
  return created;
}

async function getRoomPassword(roomId) {
  const rows = await db.select({ passwordHash: roomsTable.passwordHash })
    .from(roomsTable).where(eq(roomsTable.id, roomId)).limit(1);
  return rows.length > 0 ? rows[0].passwordHash : null;
}

async function roomExists(roomId) {
  const rows = await db.select({ id: roomsTable.id })
    .from(roomsTable).where(eq(roomsTable.id, roomId)).limit(1);
  return rows.length > 0;
}

async function touchRoom(roomId) {
  await db.update(roomsTable).set({ lastActiveAt: new Date() }).where(eq(roomsTable.id, roomId));
}

async function saveMessage(roomId, username, type, content) {
  await db.insert(messagesTable).values({
    roomId,
    username,
    type,
    content,
    ts: new Date(),
  });
  touchRoom(roomId).catch(() => {}); // fire and forget
}

async function loadHistory(roomId) {
  const rows = await db.select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.ts))
    .limit(MAX_HISTORY);

  // Reverse so oldest first, then convert to client format
  return rows.reverse().map(deserializeMessage);
}

async function loadMessagesSince(roomId, sinceMs) {
  const sinceDate = new Date(sinceMs);
  const rows = await db.select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.ts))
    .limit(MAX_HISTORY);

  return rows
    .reverse()
    .map(deserializeMessage)
    .filter((m) => (m.ts || 0) > sinceMs);
}

// Serialize message entry to DB content string
function serializeMessage(entry) {
  if (entry.type === "message") return entry.message;
  return JSON.stringify(entry); // file, image — store full payload
}

// Deserialize DB row to client-facing message object
function deserializeMessage(row) {
  const ts = row.ts instanceof Date ? row.ts.getTime() : row.ts;
  if (row.type === "message") {
    return { type: "message", username: row.username, message: row.content, ts };
  }
  // file / image types — content is JSON
  try {
    const parsed = JSON.parse(row.content);
    return { ...parsed, type: row.type, username: row.username, ts };
  } catch {
    return { type: row.type, username: row.username, message: row.content, ts };
  }
}

// ── Security headers ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── File uploads ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const token = crypto.randomBytes(8).toString("hex");
    const dir   = path.join(UPLOAD_DIR, token);
    fs.mkdirSync(dir, { recursive: true });
    req._uploadToken = token;
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname
      .replace(/[^\w.\- ]/g, "_")
      .slice(0, 128)
      .trim() || "file";
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
});

// Serve uploaded files
app.use("/uploads", (req, res, next) => {
  const rel = decodeURIComponent(req.path);
  if (rel.includes("..")) return res.status(403).end();
  next();
}, express.static(UPLOAD_DIR));

// POST /api/upload — returns { url, name, size, mime }
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = `/uploads/${req._uploadToken}/${req.file.filename}`;
  res.json({
    url,
    name: req.file.originalname,
    size: req.file.size,
    mime: req.file.mimetype || "application/octet-stream",
  });
});

// ── API key middleware ─────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== ALFRED_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// GET /api/messages/:roomId?since=<ms>
app.get("/api/messages/:roomId", requireApiKey, async (req, res) => {
  try {
    const { roomId } = req.params;
    const since = parseInt(req.query.since) || 0;
    if (!(await roomExists(roomId))) return res.status(404).json({ error: "Room not found" });
    const messages = since > 0
      ? await loadMessagesSince(roomId, since)
      : await loadHistory(roomId);
    res.json({ messages });
  } catch (err) {
    console.error("GET /api/messages error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /api/send
app.post("/api/send", requireApiKey, async (req, res) => {
  try {
    const { roomId, username, message } = req.body;
    if (!roomId || !username || !message)
      return res.status(400).json({ error: "Missing roomId, username or message" });

    // Auto-create room if it doesn't exist (bot may send before anyone joins via UI)
    await ensureRoom(roomId, null);

    await saveMessage(roomId, username, "message", message);
    io.to(roomId).emit("chat-message", { username, message });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/send error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", async ({ roomId, username, password }) => {
    if (!roomId || !username) return;

    try {
      const room = await ensureRoom(roomId, password);

      // Check password
      if (room.passwordHash && room.passwordHash !== password) {
        socket.emit("join-error", "Wrong password");
        return;
      }

      currentRoom = roomId;
      const users = getOrCreateOnlineRoom(roomId);
      users.set(socket.id, username);
      socket.join(roomId);

      socket.emit("room-info", { hasPassword: !!room.passwordHash });

      // Load history from DB
      const history = await loadHistory(roomId);
      if (history.length > 0) socket.emit("chat-history", history);

      socket.to(roomId).emit("system-message", `${username} joined`);
      io.to(roomId).emit("user-count", users.size);
      io.to(roomId).emit("user-list", Array.from(users.values()));
    } catch (err) {
      console.error("join-room error:", err);
      socket.emit("join-error", "Server error");
    }
  });

  socket.on("send-message", async ({ roomId, message }) => {
    if (!roomId || !message) return;
    const users = onlineUsers.get(roomId);
    if (!users) return;
    const username = users.get(socket.id);
    if (!username) return;

    try {
      await saveMessage(roomId, username, "message", message);
      io.to(roomId).emit("chat-message", { username, message });
    } catch (err) {
      console.error("send-message error:", err);
    }
  });

  socket.on("send-file", async ({ roomId, url, name, size, mime }) => {
    if (!roomId || !url) return;
    if (!url.startsWith("/uploads/")) return;
    const users = onlineUsers.get(roomId);
    if (!users) return;
    const username = users.get(socket.id);
    if (!username) return;

    try {
      const content = JSON.stringify({ url, name, size, mime });
      await saveMessage(roomId, username, "file", content);
      io.to(roomId).emit("chat-file", { username, url, name, size, mime });
    } catch (err) {
      console.error("send-file error:", err);
    }
  });

  // Keep legacy send-image for backward compat (old clients / dimle_bot)
  socket.on("send-image", async ({ roomId, dataUrl }) => {
    if (!roomId || !dataUrl) return;
    if (!dataUrl.startsWith("data:image/")) return;
    const users = onlineUsers.get(roomId);
    if (!users) return;
    const username = users.get(socket.id);
    if (!username) return;

    try {
      const content = JSON.stringify({ dataUrl });
      await saveMessage(roomId, username, "image", content);
      io.to(roomId).emit("chat-image", { username, dataUrl });
    } catch (err) {
      console.error("send-image error:", err);
    }
  });

  // ── Private messages ──────────────────────────────────────────────────────
  socket.on("private-message", ({ roomId, toUsername, message }) => {
    if (!roomId || !toUsername || !message) return;
    const users = onlineUsers.get(roomId);
    if (!users) return;
    const fromUsername = users.get(socket.id);
    if (!fromUsername) return;

    let toSocketId = null;
    for (const [sid, uname] of users.entries()) {
      if (uname === toUsername) { toSocketId = sid; break; }
    }

    if (!toSocketId) {
      socket.emit("private-error", { toUsername, error: "User not found or offline" });
      return;
    }

    const ts = Date.now();
    io.to(toSocketId).emit("private-message", { fromUsername, message, ts });
    socket.emit("private-message-sent", { toUsername, message, ts });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const users = onlineUsers.get(currentRoom);
    if (!users) return;
    const username = users.get(socket.id);
    users.delete(socket.id);
    if (users.size === 0) {
      onlineUsers.delete(currentRoom);
      // Room persists in DB — no deletion
    } else {
      io.to(currentRoom).emit("system-message", `${username} left`);
      io.to(currentRoom).emit("user-count", users.size);
      io.to(currentRoom).emit("user-list", Array.from(users.values()));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dimle running on http://localhost:${PORT}`);
});
