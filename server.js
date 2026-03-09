const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Rooms: Map<roomId, Map<socketId, username>>
const rooms = new Map();

// Security headers
app.use((req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !username) return;

    currentRoom = roomId;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    rooms.get(roomId).set(socket.id, username);
    socket.join(roomId);

    const userCount = rooms.get(roomId).size;

    // Notify room
    socket.to(roomId).emit("system-message", `${username} joined`);
    io.to(roomId).emit("user-count", userCount);
  });

  socket.on("send-message", ({ roomId, message }) => {
    if (!roomId || !message || !rooms.has(roomId)) return;

    const username = rooms.get(roomId).get(socket.id);
    if (!username) return;

    io.to(roomId).emit("chat-message", { username, message });
  });

  socket.on("send-image", ({ roomId, dataUrl }) => {
    if (!roomId || !dataUrl || !rooms.has(roomId)) return;
    if (!dataUrl.startsWith("data:image/")) return; // safety check

    const username = rooms.get(roomId).get(socket.id);
    if (!username) return;

    io.to(roomId).emit("chat-image", { username, dataUrl });
  });

  socket.on("disconnect", () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;

    const room = rooms.get(currentRoom);
    const username = room.get(socket.id);
    room.delete(socket.id);

    if (room.size === 0) {
      rooms.delete(currentRoom);
    } else {
      io.to(currentRoom).emit("system-message", `${username} left`);
      io.to(currentRoom).emit("user-count", room.size);
    }
  });
});

server.listen(PORT, () => {
  console.log(`BrainChat running on http://localhost:${PORT}`);
});
