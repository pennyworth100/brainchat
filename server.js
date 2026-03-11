const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");
const multer  = require("multer");
const crypto  = require("crypto");
const fs      = require("fs");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT       = process.env.PORT || 3000;
const MAX_HISTORY = 100;
const ALFRED_API_KEY = process.env.ALFRED_API_KEY || "alfred-secret";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/dimle-uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Rooms: Map<roomId, { users, history, password }>
const rooms = new Map();

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
    // Sanitise: keep alphanumeric, dot, dash, underscore, space
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
  // Prevent path traversal
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
app.get("/api/messages/:roomId", requireApiKey, (req, res) => {
  const { roomId } = req.params;
  const since = parseInt(req.query.since) || 0;
  if (!rooms.has(roomId)) return res.status(404).json({ error: "Room not found" });
  const messages = rooms.get(roomId).history.filter(m => (m.ts || 0) > since);
  res.json({ messages });
});

// POST /api/send
app.post("/api/send", requireApiKey, (req, res) => {
  const { roomId, username, message } = req.body;
  if (!roomId || !username || !message)
    return res.status(400).json({ error: "Missing roomId, username or message" });
  if (!rooms.has(roomId)) return res.status(404).json({ error: "Room not found" });
  const room  = rooms.get(roomId);
  const entry = { type: "message", username, message, ts: Date.now() };
  addToHistory(room, entry);
  io.to(roomId).emit("chat-message", { username, message });
  res.json({ ok: true });
});

function addToHistory(room, entry) {
  room.history.push(entry);
  if (room.history.length > MAX_HISTORY) room.history.shift();
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomId, username, password }) => {
    if (!roomId || !username) return;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { users: new Map(), history: [], password: password || null });
    }

    const room = rooms.get(roomId);
    if (room.password && room.password !== password) {
      socket.emit("join-error", "Wrong password");
      return;
    }

    currentRoom = roomId;
    room.users.set(socket.id, username);
    socket.join(roomId);

    socket.emit("room-info", { hasPassword: !!room.password });
    if (room.history.length > 0) socket.emit("chat-history", room.history);

    socket.to(roomId).emit("system-message", `${username} joined`);
    io.to(roomId).emit("user-count", room.users.size);
    io.to(roomId).emit("user-list", Array.from(room.users.values()));
  });

  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message || !rooms.has(roomId)) return;
    const room     = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "message", username, message, ts: Date.now() };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-message", { username, message });
  });

  // New unified file event (replaces old send-image)
  socket.on("send-file", ({ roomId, url, name, size, mime }) => {
    if (!roomId || !url || !rooms.has(roomId)) return;
    if (!url.startsWith("/uploads/")) return; // security
    const room     = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "file", username, url, name, size, mime, ts: Date.now() };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-file", { username, url, name, size, mime });
  });

  // Keep legacy send-image for backward compat (old clients / dimle_bot)
  socket.on("send-image", ({ roomId, dataUrl }) => {
    if (!roomId || !dataUrl || !rooms.has(roomId)) return;
    if (!dataUrl.startsWith("data:image/")) return;
    const room     = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "image", username, dataUrl, ts: Date.now() };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-image", { username, dataUrl });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room     = rooms.get(currentRoom);
    const username = room.users.get(socket.id);
    room.users.delete(socket.id);
    if (room.users.size === 0) {
      rooms.delete(currentRoom);
    } else {
      io.to(currentRoom).emit("system-message", `${username} left`);
      io.to(currentRoom).emit("user-count", room.users.size);
      io.to(currentRoom).emit("user-list", Array.from(room.users.values()));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dimle running on http://localhost:${PORT}`);
});
