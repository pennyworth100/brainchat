const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 100;
const ALFRED_API_KEY = process.env.ALFRED_API_KEY || "alfred-secret";

// Rooms: Map<roomId, { users, history, password }>
const rooms = new Map();

// Security headers
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// API key middleware
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== ALFRED_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// GET /api/messages/:roomId?since=<unixTimestampMs>
app.get("/api/messages/:roomId", requireApiKey, (req, res) => {
  const { roomId } = req.params;
  const since = parseInt(req.query.since) || 0;
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  const room = rooms.get(roomId);
  const messages = room.history.filter(m => (m.ts || 0) > since);
  res.json({ messages });
});

// POST /api/send
app.post("/api/send", requireApiKey, (req, res) => {
  const { roomId, username, message } = req.body;
  if (!roomId || !username || !message) {
    return res.status(400).json({ error: "Missing roomId, username or message" });
  }
  if (!rooms.has(roomId)) {
    return res.status(404).json({ error: "Room not found" });
  }
  const room = rooms.get(roomId);
  const entry = { type: "message", username, message, ts: Date.now() };
  addToHistory(room, entry);
  io.to(roomId).emit("chat-message", { username, message });
  res.json({ ok: true });
});

function addToHistory(room, entry) {
  room.history.push(entry);
  if (room.history.length > MAX_HISTORY) room.history.shift();
}

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomId, username, password }) => {
    if (!roomId || !username) return;

    const isNewRoom = !rooms.has(roomId);

    if (isNewRoom) {
      // Pierwszy uczestnik tworzy pokój i ustawia hasło (opcjonalne)
      rooms.set(roomId, {
        users: new Map(),
        history: [],
        password: password || null
      });
    }

    const room = rooms.get(roomId);

    // Weryfikacja hasła
    if (room.password && room.password !== password) {
      socket.emit("join-error", "Wrong password");
      return;
    }

    currentRoom = roomId;
    room.users.set(socket.id, username);
    socket.join(roomId);

    // Poinformuj czy pokój ma hasło (dla nowych uczestników)
    socket.emit("room-info", { hasPassword: !!room.password });

    // Wyślij historię
    if (room.history.length > 0) {
      socket.emit("chat-history", room.history);
    }

    socket.to(roomId).emit("system-message", `${username} joined`);
    io.to(roomId).emit("user-count", room.users.size);
    io.to(roomId).emit("user-list", Array.from(room.users.values()));
  });

  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "message", username, message, ts: Date.now() };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-message", { username, message });
  });

  socket.on("send-image", ({ roomId, dataUrl }) => {
    if (!roomId || !dataUrl || !rooms.has(roomId)) return;
    if (!dataUrl.startsWith("data:image/")) return;
    const room = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "image", username, dataUrl, ts: Date.now() };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-image", { username, dataUrl });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);
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
