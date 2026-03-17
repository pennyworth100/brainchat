const { pgTable, text, integer, timestamp, serial } = require("drizzle-orm/pg-core");

const rooms = pgTable("rooms", {
  id:           text("id").primaryKey(),               // user-chosen room code
  passwordHash: text("password_hash"),                 // plain text for now (matches current behavior)
  createdAt:    timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

const messages = pgTable("messages", {
  id:       serial("id").primaryKey(),
  roomId:   text("room_id").notNull().references(() => rooms.id),
  username: text("username").notNull(),
  type:     text("type").notNull().default("message"),  // message | file | image
  content:  text("content").notNull(),                  // JSON string for file/image metadata, plain text for messages
  ts:       timestamp("ts").defaultNow().notNull(),
});

module.exports = { rooms, messages };
