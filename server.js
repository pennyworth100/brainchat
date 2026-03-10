const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 100;

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
    const entry = { type: "message", username, message };
    addToHistory(room, entry);
    io.to(roomId).emit("chat-message", { username, message });
  });

  socket.on("send-image", ({ roomId, dataUrl }) => {
    if (!roomId || !dataUrl || !rooms.has(roomId)) return;
    if (!dataUrl.startsWith("data:image/")) return;
    const room = rooms.get(roomId);
    const username = room.users.get(socket.id);
    if (!username) return;
    const entry = { type: "image", username, dataUrl };
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
