import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  username: text("username").notNull(),
  type: text("type").notNull().default("message"),
  content: text("content").notNull(),
  ts: timestamp("ts").defaultNow().notNull(),
});
