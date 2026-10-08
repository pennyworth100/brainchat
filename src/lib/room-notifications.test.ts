import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "./room-session";
import { roomDocumentTitle, roomNotificationBody, shouldNotifyRoomMessage } from "./room-notifications";

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 1,
  type: "message",
  username: "Max",
  message: "Hello Alfred",
  ts: 1,
  ...overrides,
});

test("only background messages from another participant notify", () => {
  assert.equal(shouldNotifyRoomMessage(message(), "Alfred", "hidden"), true);
  assert.equal(shouldNotifyRoomMessage(message(), "Alfred", "visible"), false);
  assert.equal(shouldNotifyRoomMessage(message({ username: "Alfred" }), "Alfred", "hidden"), false);
  assert.equal(shouldNotifyRoomMessage(message(), null, "hidden"), false);
});

test("unread title is readable and clears back to the room title", () => {
  assert.equal(roomDocumentTitle("spoon651", 3), "(3) Dimle · spoon651");
  assert.equal(roomDocumentTitle("spoon651", 0), "Dimle · spoon651");
});

test("notification body describes attachments and truncates long messages", () => {
  assert.equal(roomNotificationBody(message({ type: "image", message: undefined })), "Sent an image");
  assert.equal(roomNotificationBody(message({ type: "file", message: undefined, name: "report.pdf" })), "Sent a file: report.pdf");
  assert.equal(roomNotificationBody(message({ message: "x".repeat(200) })).length, 160);
});
