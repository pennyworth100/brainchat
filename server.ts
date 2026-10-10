import express from "express";
import http from "http";
import { Server, type Socket } from "socket.io";
import next from "next";
import path from "path";
import multer from "multer";
import { createUploadParser } from "./src/lib/upload-parser";
import crypto from "crypto";
import fs from "fs";
import { and, asc, eq, desc, gt } from "drizzle-orm";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./src/lib/db";
import {
  authenticateAgent,
  loadAgentPrincipals,
  type AgentPrincipal,
} from "./src/lib/agent-api-auth";
import type { JoinErrorDetails } from "./src/lib/join-error";
import { registerPrivateMessages } from "./src/lib/private-message";
import { claimRoomPolicy } from "./src/lib/room-policy";
import { rooms as roomsTable, messages as messagesTable } from "./src/lib/db/schema";
import {
  generateCreationToken,
  generateRoomId,
  hashCreationToken,
  hashPassword,
  isValidRoomId,
  normalizeRoomId,
  safeEqual,
  verifyPassword,
} from "./src/lib/security";

const dev = process.env.NODE_ENV !== "production";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_HISTORY = 100;
const AGENT_PRINCIPALS = loadAgentPrincipals(
  process.env.ALFRED_API_KEY,
  process.env.DIMLE_AGENT_API_KEYS_JSON
);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/tmp/dimle-uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 256;
const MAX_USERNAME_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 10_000;
const MAX_IMAGE_DATA_URL_LENGTH = 12 * 1024 * 1024;

class IdempotencyConflictError extends Error {}

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
  const [row] = await db
    .insert(messagesTable)
    .values({ roomId, username, type, content, ts: new Date() })
    .returning();
  touchRoom(roomId).catch(() => {});
  return deserializeMessage(row);
}

async function saveAgentMessage(
  roomId: string,
  username: string,
  content: string,
  clientMessageId?: string
) {
  if (!clientMessageId) {
    return { message: await saveMessage(roomId, username, "message", content), deduplicated: false };
  }

  const [inserted] = await db
    .insert(messagesTable)
    .values({ roomId, username, type: "message", content, clientMessageId, ts: new Date() })
    .onConflictDoNothing({
      target: [messagesTable.roomId, messagesTable.username, messagesTable.clientMessageId],
    })
    .returning();

  if (inserted) {
    touchRoom(roomId).catch(() => {});
    return { message: deserializeMessage(inserted), deduplicated: false };
  }

  const [existing] = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.roomId, roomId),
        eq(messagesTable.username, username),
        eq(messagesTable.clientMessageId, clientMessageId)
      )
    )
    .limit(1);
  if (!existing) throw new Error("Idempotent message conflict could not be resolved");
  if (existing.type !== "message" || existing.content !== content) {
    throw new IdempotencyConflictError("clientMessageId was already used for another payload");
  }
  return { message: deserializeMessage(existing), deduplicated: true };
}

interface MessageRow {
  id: number;
  roomId: string;
  username: string;
  type: string;
  content: string;
  clientMessageId: string | null;
  ts: Date;
}

function deserializeMessage(row: MessageRow) {
  const ts = row.ts instanceof Date ? row.ts.getTime() : row.ts;
  if (row.type === "message") {
    return { id: row.id, type: "message", username: row.username, message: row.content, ts };
  }
  try {
    const parsed = JSON.parse(row.content);
    return { ...parsed, id: row.id, type: row.type, username: row.username, ts };
  } catch {
    return { id: row.id, type: row.type, username: row.username, message: row.content, ts };
  }
}

async function loadHistory(roomId: string) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.id))
    .limit(MAX_HISTORY);
  return rows.reverse().map(deserializeMessage);
}

async function loadMessagesSince(roomId: string, sinceMs: number) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.roomId, roomId))
    .orderBy(desc(messagesTable.id))
    .limit(MAX_HISTORY);
  return rows
    .reverse()
    .map(deserializeMessage)
    .filter((m) => (m.ts || 0) > sinceMs);
}

async function loadMessagesAfterId(roomId: string, afterId: number) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.roomId, roomId), gt(messagesTable.id, afterId)))
    .orderBy(asc(messagesTable.id))
    .limit(MAX_HISTORY);
  return rows.map(deserializeMessage);
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
  const uploadLimiter = new RateLimiterPostgres({
    ...rateLimiterStore,
    keyPrefix: "upload",
    points: 30,
    duration: 60 * 60,
  });

  // Security headers
  expressApp.disable("x-powered-by");
  expressApp.use((_req, res, nxt) => {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()"
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:"
    );
    nxt();
  });

  expressApp.use(express.json({ limit: "32kb" }));

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
      let rel: string;
      try {
        rel = decodeURIComponent(req.path);
      } catch {
        return res.status(400).end();
      }
      // Reject parent-directory segments, not ordinary names like report..pdf.
      if (rel.split(/[\\/]/).includes("..")) return res.status(403).end();
      nxt();
    },
    express.static(UPLOAD_DIR, {
      setHeaders: (res) => {
        res.setHeader("Content-Disposition", "attachment");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.setHeader("Cache-Control", "private, max-age=3600");
      },
    })
  );

  // ── File uploads ──────────────────────────────────────────────────────────
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const token = crypto.randomBytes(8).toString("hex");
      const dir = path.join(UPLOAD_DIR, token);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        return cb(error as Error, dir);
      }
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

  const uploadMiddleware = createUploadParser(storage, MAX_FILE_SIZE);

  expressApp.post(
    "/api/upload",
    async (req, res, nxt) => {
      const rawRoomId = req.headers["x-room-id"];
      const socketId = req.headers["x-socket-id"];
      if (
        typeof rawRoomId !== "string" ||
        typeof socketId !== "string" ||
        !isValidRoomId(rawRoomId)
      ) {
        return res.status(401).json({ error: "Join the room before uploading" });
      }
      const roomId = normalizeRoomId(rawRoomId);
      const users = onlineUsers.get(roomId);
      const activeSocket = io.sockets.sockets.get(socketId);
      if (!users?.has(socketId) || !activeSocket?.rooms.has(roomId)) {
        return res.status(401).json({ error: "Join the room before uploading" });
      }
      res.locals.uploadIdentity = { roomId, username: users.get(socketId)! };
      try {
        await uploadLimiter.consume(`${req.ip || "unknown"}:${socketId}`);
        nxt();
      } catch (err) {
        if (typeof err === "object" && err && "msBeforeNext" in err) {
          res.setHeader(
            "Retry-After",
            Math.ceil(Number(err.msBeforeNext) / 1000).toString()
          );
        }
        return res.status(429).json({ error: "Too many uploads. Try again later." });
      }
    },
    uploadMiddleware,
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: "No file" });
      const token = (req as express.Request & { _uploadToken: string })._uploadToken;
      const file = {
        url: `/uploads/${token}/${req.file.filename}`,
        name: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype || "application/octet-stream",
      };
      const { roomId, username } = res.locals.uploadIdentity;
      let message: Awaited<ReturnType<typeof saveMessage>>;
      try {
        message = await saveMessage(roomId, username, "file", JSON.stringify(file));
      } catch (err) {
        // A rejected INSERT result is NOT proof of rollback. Preserve the bytes
        // even when no row is visible: there is no safe retry/reclamation receipt.
        console.error("upload persistence outcome unknown:", err);
        return res.status(500).json({
          code: "UPLOAD_OUTCOME_UNKNOWN",
          error: "Attachment status is unknown. Check room history before uploading again.",
        });
      }
      try {
        // Publication failure cannot invalidate an acknowledged saved message.
        io.to(roomId).emit("chat-file", message);
      } catch (err) {
        console.error("upload notification error after save:", err);
      }
      // A response failure/disconnected client must never trigger byte cleanup.
      try {
        res.json({ ...file, message });
      } catch (err) {
        console.error("upload response error after save:", err);
        res.destroy();
      }
    }
  );

  // ── API key middleware ────────────────────────────────────────────────────
  function requireApiKey(
    req: express.Request,
    res: express.Response,
    nxt: express.NextFunction
  ) {
    const key = req.headers["x-api-key"];
    if (AGENT_PRINCIPALS.length === 0)
      return res.status(503).json({ error: "API integration is not configured" });
    const principal = authenticateAgent(typeof key === "string" ? key : undefined, AGENT_PRINCIPALS);
    if (!principal)
      return res.status(401).json({ error: "Unauthorized" });
    res.locals.agentPrincipal = principal;
    nxt();
  }

  // GET /api/messages/:roomId
  expressApp.get(
    "/api/messages/:roomId",
    requireApiKey,
    async (req, res) => {
      try {
        const rawRoomId = req.params.roomId as string;
        if (!isValidRoomId(rawRoomId))
          return res.status(400).json({ error: "Invalid room ID" });
        const roomId = normalizeRoomId(rawRoomId);
        const rawAfterId = req.query.afterId;
        const afterId = typeof rawAfterId === "string" && /^\d+$/.test(rawAfterId)
          ? Number(rawAfterId)
          : null;
        if (rawAfterId !== undefined && (!Number.isSafeInteger(afterId) || afterId! < 0))
          return res.status(400).json({ error: "Invalid afterId cursor" });
        const since = parseInt(req.query.since as string) || 0;
        if (!(await roomExists(roomId)))
          return res.status(404).json({ error: "Room not found" });
        const msgs =
          afterId !== null
            ? await loadMessagesAfterId(roomId, afterId)
            : since > 0
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
      const { roomId: rawRoomId, message, clientMessageId } = req.body;
      const principal = res.locals.agentPrincipal as AgentPrincipal;
      if (!rawRoomId || !message)
        return res
          .status(400)
          .json({ error: "Missing roomId or message" });
      if (
        typeof rawRoomId !== "string" ||
        !isValidRoomId(rawRoomId) ||
        typeof message !== "string" ||
        message.length > MAX_MESSAGE_LENGTH ||
        (clientMessageId !== undefined &&
          (typeof clientMessageId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)))
      ) {
        return res.status(400).json({ error: "Invalid message payload" });
      }
      const roomId = normalizeRoomId(rawRoomId);
      const room = await getRoom(roomId);
      if (!room || room.creationTokenHash)
        return res.status(404).json({ error: "Room not found" });
      const result = await saveAgentMessage(
        roomId,
        principal.username,
        message,
        clientMessageId
      );
      if (!result.deduplicated) io.to(roomId).emit("chat-message", result.message);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: err.message });
      }
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
        roomId: rawRoomId,
        username,
        password,
        creationToken,
      }: {
        roomId: string;
        username: string;
        password?: string;
        creationToken?: string;
      }) => {
        if (typeof rawRoomId !== "string" || !rawRoomId || !username) return;
        if (!isValidRoomId(rawRoomId)) {
          socket.emit("join-error", "Invalid room ID");
          return;
        }
        const roomId = normalizeRoomId(rawRoomId);
        if (typeof username !== "string" || username.length > MAX_USERNAME_LENGTH) {
          socket.emit("join-error", "Username is too long");
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
            const claimed = await claimRoomPolicy(pool, roomId, room.creationTokenHash, passwordHash);
            if (!claimed) {
              socket.emit("join-error", "Room was already claimed");
              return;
            }
            room = { ...room, ...claimed };
          } else if (
            room.passwordHash &&
            !(await verifyPassword(room.passwordHash, password || ""))
          ) {
            socket.emit("join-error", "Wrong password");
            return;
          }
          if (!socket.connected) return;
          // This client has one active room. Do not leave stale memberships.
          if (currentRoom && currentRoom !== roomId) return;
          currentRoom = roomId;
          const users = getOrCreateOnlineRoom(roomId);
          users.set(socket.id, username);
          await socket.join(roomId);
          socket.emit("room-info", { hasPassword: !!room.passwordHash });
          const history = await loadHistory(roomId);
          if (!socket.connected) return;
          socket.emit("chat-history", history); // v3.0.1 compatibility
          socket.emit("room-snapshot", { history, users: Array.from(users.values()) });
          socket.to(roomId).emit("system-message", `${username} joined`);
          io.to(roomId).emit("user-count", users.size);
          io.to(roomId).emit("user-list", Array.from(users.values()));
        } catch (err) {
          if (typeof err === "object" && err && "msBeforeNext" in err) {
            socket.emit("join-error", "Too many attempts. Try again later.", {
              code: "RATE_LIMITED", retryAfterMs: Number(err.msBeforeNext),
            } satisfies JoinErrorDetails);
            return;
          }
          console.error("join-room error:", err);
          socket.emit("join-error", "Server error", { code: "SERVER_ERROR" } satisfies JoinErrorDetails);
        }
      }
    );

    socket.on("sync-room", async (payload: { roomId?: unknown; probeOnly?: unknown } | null, ack) => {
      if (typeof ack !== "function") return;
      const roomId = payload?.roomId;
      if (typeof roomId !== "string" || roomId !== currentRoom || !socket.rooms.has(roomId) || !onlineUsers.get(roomId)?.has(socket.id)) {
        return ack({ error: "Rejoin the room" });
      }
      // Membership/transport liveness only, not database or history readiness.
      // Keep the existing event for rolling compatibility with older clients.
      if (payload?.probeOnly === true) return ack({ ok: true });
      try {
        const history = await loadHistory(roomId);
        if (!socket.connected) return;
        ack({ history, users: Array.from(onlineUsers.get(roomId)?.values() || []) });
      } catch (err) {
        console.error("sync-room error:", err);
        ack({ error: "Could not sync the room" });
      }
    });

    socket.on(
      "send-message",
      async ({ roomId, message }: { roomId: string; message: string }, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        if (!roomId || typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_LENGTH) {
          return reply({ error: "Invalid message" });
        }
        const username = onlineUsers.get(roomId)?.get(socket.id);
        if (!username || !socket.rooms.has(roomId)) return reply({ error: "Rejoin the room before sending" });
        try {
          const saved = await saveMessage(roomId, username, "message", message);
          io.to(roomId).emit("chat-message", saved);
          reply({ message: saved });
        } catch (err) {
          console.error("send-message error:", err);
          reply({ error: "Could not save the message" });
        }
      }
    );

    // Files are now saved and broadcast by POST /api/upload. The old
    // v3.0.1 send-file notification is intentionally ignored to avoid doubles.

    socket.on(
      "send-image",
      async ({ roomId, dataUrl }: { roomId: string; dataUrl: string }) => {
        if (!roomId || !dataUrl) return;
        if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return;
        if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(dataUrl)) return;
        const users = onlineUsers.get(roomId);
        if (!users) return;
        const username = users.get(socket.id);
        if (!username) return;
        try {
          const content = JSON.stringify({ dataUrl });
          const saved = await saveMessage(roomId, username, "image", content);
          io.to(roomId).emit("chat-image", saved);
        } catch (err) {
          console.error("send-image error:", err);
        }
      }
    );

    registerPrivateMessages(io, socket, onlineUsers);

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

  expressApp.use(
    (err: unknown, _req: express.Request, res: express.Response, nxt: express.NextFunction) => {
      if (err instanceof multer.MulterError) {
        return res
          .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
          .json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is too large" : "Invalid upload" });
      }
      nxt(err);
    }
  );

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
