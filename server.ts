import express from "express";
import http from "http";
import { Server, type Socket } from "socket.io";
import next from "next";
import path from "path";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import { and, eq, desc } from "drizzle-orm";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./src/lib/db";
import { rooms as roomsTable, messages as messagesTable } from "./src/lib/db/schema";
import {
  generateCreationToken,
  generateRoomId,
  hashCreationToken,
  hashPassword,
  isValidRoomId,
  safeEqual,
  verifyPassword,
} from "./src/lib/security";

const dev = process.env.NODE_ENV !== "production";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_HISTORY = 100;
const ALFRED_API_KEY = process.env.ALFRED_API_KEY;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/dimle-uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 256;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory: online users per room (transient socket state)
const onlineUsers = new Map<string, Map<string, string>>();

function getOrCreateOnlineRoom(roomId: string) {
  if (!onlineUsers.has(roomId)) onlineUsers.set(roomId, new Map());
  return onlineUsers.get(roomId)!;
}

function getSocketClientIp(
  socket: Socket,
  trustProxyHops: number
) {
  const remoteAddress = socket.handshake.address || "unknown";
  if (trustProxyHops <= 0) return remoteAddress;

  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!forwardedValue) return remoteAddress;

  const addresses = forwardedValue
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  return addresses[Math.max(0, addresses.length - trustProxyHops)] || remoteAddress;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function getRoom(roomId: string) {
  const rows = await db
    .select()
    .from(roomsTable)
    .where(eq(roomsTable.id, roomId))
    .limit(1);
  return rows[0] ?? null;
}

async function roomExists(roomId: string) {
  const rows = await db
    .select({ id: roomsTable.id })
    .from(roomsTable)
    .where(eq(roomsTable.id, roomId))
    .limit(1);
  return rows.length > 0;
}

async function touchRoom(roomId: string) {
  await db
    .update(roomsTable)
    .set({ lastActiveAt: new Date() })
    .where(eq(roomsTable.id, roomId));
}

async function saveMessage(
  roomId: string,
  username: string,
  type: string,
  content: string
) {
  await db
    .insert(messagesTable)
    .values({ roomId, username, type, content, ts: new Date() });
  touchRoom(roomId).catch(() => {});
}

interface MessageRow {
  id: number;
  roomId: string;
  username: string;
  type: string;
  content: string;
  ts: Date;
}

function deserializeMessage(row: MessageRow) {
  const ts = row.ts instanceof Date ? row.ts.getTime() : row.ts;
  if (row.type === "message") {
    return { type: "message", username: row.username, message: row.content, ts };
  }
  try {
    const parsed = JSON.parse(row.content);
    return { ...parsed, type: row.type, username: row.username, ts };
  } catch {
    return { type: row.type, username: row.username, message: row.content, ts };
  }
}

async function loadHistory(roomId: string) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.ts))
    .limit(MAX_HISTORY);
  return rows.reverse().map(deserializeMessage);
}

async function loadMessagesSince(roomId: string, sinceMs: number) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.ts))
    .limit(MAX_HISTORY);
  return rows
    .reverse()
    .map(deserializeMessage)
    .filter((m) => (m.ts || 0) > sinceMs);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Run migrations
  console.log("Running database migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");

  const app = next({ dev });
  const handle = app.getRequestHandler();
  await app.prepare();

  const expressApp = express();
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || "0", 10);
  if (trustProxyHops > 0) expressApp.set("trust proxy", trustProxyHops);
  const server = http.createServer(expressApp);
  const io = new Server(server);

  const rateLimiterStore = {
    storeClient: pool,
    storeType: "pool" as const,
    tableName: "rate_limits",
    tableCreated: true,
  };
  const createRoomLimiter = new RateLimiterPostgres({
    ...rateLimiterStore,
    keyPrefix: "create-room",
    points: 10,
    duration: 60 * 60,
  });
  const joinIpLimiter = new RateLimiterPostgres({
    ...rateLimiterStore,
    keyPrefix: "join-ip",
    points: 20,
    duration: 60,
  });
  const joinRoomLimiter = new RateLimiterPostgres({
    ...rateLimiterStore,
    keyPrefix: "join-room",
    points: 8,
    duration: 60,
  });

  // Security headers
  expressApp.use((_req, res, nxt) => {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    nxt();
  });

  expressApp.use(express.json());

  // ── Room creation ─────────────────────────────────────────────────────────
  expressApp.post("/api/rooms", async (req, res) => {
    try {
      await createRoomLimiter.consume(req.ip || req.socket.remoteAddress || "unknown");
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomId = generateRoomId();
        const creationToken = generateCreationToken();
        const [created] = await db
          .insert(roomsTable)
          .values({
            id: roomId,
            creationTokenHash: hashCreationToken(creationToken),
          })
          .onConflictDoNothing()
          .returning({ id: roomsTable.id });

        if (created) {
          return res.status(201).json({ roomId, creationToken });
        }
      }

      return res.status(503).json({ error: "Could not create room" });
    } catch (err) {
      if (typeof err === "object" && err && "msBeforeNext" in err) {
        res.setHeader(
          "Retry-After",
          Math.ceil(Number(err.msBeforeNext) / 1000).toString()
        );
        return res
          .status(429)
          .json({ error: "Too many rooms created. Try again later." });
      }
      console.error("POST /api/rooms error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Serve uploaded files ──────────────────────────────────────────────────
  expressApp.use(
    "/uploads",
    (req, res, nxt) => {
      const rel = decodeURIComponent(req.path);
      if (rel.includes("..")) return res.status(403).end();
      nxt();
    },
    express.static(UPLOAD_DIR)
  );

  // ── File uploads ──────────────────────────────────────────────────────────
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const token = crypto.randomBytes(8).toString("hex");
      const dir = path.join(UPLOAD_DIR, token);
      fs.mkdirSync(dir, { recursive: true });
      (req as express.Request & { _uploadToken: string })._uploadToken = token;
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe =
        file.originalname
          .replace(/[^\w.\- ]/g, "_")
          .slice(0, 128)
          .trim() || "file";
      cb(null, safe);
    },
  });

  const uploadMiddleware = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

  expressApp.post(
    "/api/upload",
    uploadMiddleware.single("file"),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: "No file" });
      const token = (req as express.Request & { _uploadToken: string })
        ._uploadToken;
      const url = `/uploads/${token}/${req.file.filename}`;
      res.json({
        url,
        name: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype || "application/octet-stream",
      });
    }
  );

  // ── API key middleware ────────────────────────────────────────────────────
  function requireApiKey(
    req: express.Request,
    res: express.Response,
    nxt: express.NextFunction
  ) {
    const key = req.headers["x-api-key"];
    if (!ALFRED_API_KEY)
      return res.status(503).json({ error: "API integration is not configured" });
    if (typeof key !== "string" || !safeEqual(key, ALFRED_API_KEY))
      return res.status(401).json({ error: "Unauthorized" });
    nxt();
  }

  // GET /api/messages/:roomId
  expressApp.get(
    "/api/messages/:roomId",
    requireApiKey,
    async (req, res) => {
      try {
        const roomId = req.params.roomId as string;
        const since = parseInt(req.query.since as string) || 0;
        if (!(await roomExists(roomId)))
          return res.status(404).json({ error: "Room not found" });
        const msgs =
          since > 0
            ? await loadMessagesSince(roomId, since)
            : await loadHistory(roomId);
        res.json({ messages: msgs });
      } catch (err) {
        console.error("GET /api/messages error:", err);
        res.status(500).json({ error: "Internal error" });
      }
    }
  );

  // POST /api/send
  expressApp.post("/api/send", requireApiKey, async (req, res) => {
    try {
      const { roomId, username, message } = req.body;
      if (!roomId || !username || !message)
        return res
          .status(400)
          .json({ error: "Missing roomId, username or message" });
      const room = await getRoom(roomId);
      if (!room || room.creationTokenHash)
        return res.status(404).json({ error: "Room not found" });
      await saveMessage(roomId, username, "message", message);
      io.to(roomId).emit("chat-message", { username, message });
      res.json({ ok: true });
    } catch (err) {
      console.error("POST /api/send error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // ── Socket.io ─────────────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    let currentRoom: string | null = null;

    socket.on(
      "join-room",
      async ({
        roomId,
        username,
        password,
        creationToken,
      }: {
        roomId: string;
        username: string;
        password?: string;
        creationToken?: string;
      }) => {
        if (!roomId || !username) return;
        if (!isValidRoomId(roomId)) {
          socket.emit("join-error", "Invalid room ID");
          return;
        }
        if ((password?.length ?? 0) > MAX_PASSWORD_LENGTH) {
          socket.emit("join-error", "Password is too long");
          return;
        }
        try {
          const clientIp = getSocketClientIp(socket, trustProxyHops);
          await Promise.all([
            joinIpLimiter.consume(clientIp),
            joinRoomLimiter.consume(`${clientIp}:${roomId}`),
          ]);

          let room = await getRoom(roomId);
          if (!room) {
            socket.emit("join-error", "Room not found");
            return;
          }

          if (room.creationTokenHash) {
            const providedTokenHash = creationToken
              ? hashCreationToken(creationToken)
              : "";
            if (!safeEqual(room.creationTokenHash, providedTokenHash)) {
              socket.emit("join-error", "Room is not ready yet");
              return;
            }

            const passwordHash = password ? await hashPassword(password) : null;
            const [claimed] = await db
              .update(roomsTable)
              .set({ passwordHash, creationTokenHash: null })
              .where(
                and(
                  eq(roomsTable.id, roomId),
                  eq(roomsTable.creationTokenHash, room.creationTokenHash)
                )
              )
              .returning();
            if (!claimed) {
              socket.emit("join-error", "Room was already claimed");
              return;
            }
            room = claimed;
          } else if (
            room.passwordHash &&
            !(await verifyPassword(room.passwordHash, password || ""))
          ) {
            socket.emit("join-error", "Wrong password");
            return;
          }
          currentRoom = roomId;
          const users = getOrCreateOnlineRoom(roomId);
          users.set(socket.id, username);
          socket.join(roomId);
          socket.emit("room-info", { hasPassword: !!room.passwordHash });
          const history = await loadHistory(roomId);
          if (history.length > 0) socket.emit("chat-history", history);
          socket.to(roomId).emit("system-message", `${username} joined`);
          io.to(roomId).emit("user-count", users.size);
          io.to(roomId).emit("user-list", Array.from(users.values()));
        } catch (err) {
          if (typeof err === "object" && err && "msBeforeNext" in err) {
            socket.emit("join-error", "Too many attempts. Try again later.");
            return;
          }
          console.error("join-room error:", err);
          socket.emit("join-error", "Server error");
        }
      }
    );

    socket.on(
      "send-message",
      async ({ roomId, message }: { roomId: string; message: string }) => {
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
      }
    );

    socket.on(
      "send-file",
      async ({
        roomId,
        url,
        name,
        size,
        mime,
      }: {
        roomId: string;
        url: string;
        name: string;
        size: number;
        mime: string;
      }) => {
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
      }
    );

    socket.on(
      "send-image",
      async ({ roomId, dataUrl }: { roomId: string; dataUrl: string }) => {
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
      }
    );

    socket.on(
      "private-message",
      ({
        roomId,
        toUsername,
        message,
      }: {
        roomId: string;
        toUsername: string;
        message: string;
      }) => {
        if (!roomId || !toUsername || !message) return;
        const users = onlineUsers.get(roomId);
        if (!users) return;
        const fromUsername = users.get(socket.id);
        if (!fromUsername) return;

        let toSocketId: string | null = null;
        for (const [sid, uname] of users.entries()) {
          if (uname === toUsername) {
            toSocketId = sid;
            break;
          }
        }

        if (!toSocketId) {
          socket.emit("private-error", {
            toUsername,
            error: "User not found or offline",
          });
          return;
        }

        const ts = Date.now();
        io.to(toSocketId).emit("private-message", { fromUsername, message, ts });
        socket.emit("private-message-sent", { toUsername, message, ts });
      }
    );

    socket.on("disconnect", () => {
      if (!currentRoom) return;
      const users = onlineUsers.get(currentRoom);
      if (!users) return;
      const username = users.get(socket.id);
      users.delete(socket.id);
      if (users.size === 0) {
        onlineUsers.delete(currentRoom);
      } else {
        io.to(currentRoom).emit("system-message", `${username} left`);
        io.to(currentRoom).emit("user-count", users.size);
        io.to(currentRoom).emit(
          "user-list",
          Array.from(users.values())
        );
      }
    });
  });

  // ── Next.js handler (catch-all) ──────────────────────────────────────────
  expressApp.all("*", (req, res) => {
    return handle(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Dimle running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
