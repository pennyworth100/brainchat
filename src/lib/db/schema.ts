import { sql } from "drizzle-orm";
import {
  check,
  bigint,
  integer,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  authVersion: integer("auth_version").default(1).notNull(),
  passwordHash: text("password_hash"),
  creationTokenHash: text("creation_token_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    username: text("username").notNull(),
    type: text("type").notNull().default("message"),
    content: text("content").notNull(),
    clientMessageId: varchar("client_message_id", { length: 128 }),
    ts: timestamp("ts").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("messages_agent_idempotency_idx").on(
      table.roomId,
      table.username,
      table.clientMessageId
    ),
  ]
);

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 255 }).primaryKey(),
  points: integer("points").default(0).notNull(),
  expire: bigint("expire", { mode: "number" }),
});

export const roomResumeSessions = pgTable("room_resume_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  authVersion: integer("auth_version").notNull(),
  generation: integer("generation").default(0).notNull(),
  lastOperationId: text("last_operation_id"),
  lastTransportId: text("last_transport_id"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [index("resume_sessions_expiry_idx").on(table.expiresAt, table.id)]);

// Receipt survives message deletion (NULL is a tombstone), but not session deletion.
export const resumeMessageReceipts = pgTable("resume_message_receipts", {
  sessionId: text("session_id").notNull().references(() => roomResumeSessions.id, { onDelete: "cascade" }),
  clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
}, table => [
  primaryKey({ columns: [table.sessionId, table.clientMessageId] }),
  index("resume_receipts_message_idx").on(table.messageId),
]);

// PRIVATE: absent budget row denies all uploads. Provision only after a real
// volume/headroom audit. No automatic seed, refund, cleanup or cascading delete.
export const resumeUploadBudget = pgTable("resume_upload_budget", {
  id: integer("id").primaryKey(),
  capacityBytes: bigint("capacity_bytes", { mode: "number" }).notNull(),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).default(0).notNull(),
}, t => [check("resume_upload_budget_bounds", sql`${t.id} = 1 AND ${t.capacityBytes} > 0 AND ${t.capacityBytes} <= 9007199254740991 AND ${t.reservedBytes} >= 0 AND ${t.reservedBytes} <= ${t.capacityBytes}`)]);

// Provenance intentionally survives session/room/receipt expiry and deletion.
export const resumeUploadAttempts = pgTable("resume_upload_attempts", {
  storageKey: varchar("storage_key", { length: 64 }).primaryKey(),
  sessionId: text("session_id").notNull(),
  roomId: text("room_id").notNull(),
  clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [check("resume_upload_attempt_bounds", sql`${t.reservedBytes} > 0 AND ${t.reservedBytes} <= 104857600 AND ${t.storageKey} ~ '^[0-9a-f]{64}$'`)]);
