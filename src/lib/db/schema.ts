import {
  bigint,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
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
