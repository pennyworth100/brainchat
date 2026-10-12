-- PRIVATE acceptance prototype only. NOT a registered startup migration.
-- Install/backfill are one transaction while ALL inserts are fenced.
-- Pending-set reconciliation: message_id is identity, NEVER a commit watermark.
BEGIN;
LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE message_publication_pending (
  message_id integer PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX message_publication_room ON message_publication_pending(room_id, message_id);
CREATE FUNCTION enqueue_message_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO message_publication_pending(message_id, room_id)
  VALUES (NEW.id, NEW.room_id);
  RETURN NEW;
END
$$;
CREATE TRIGGER message_publication_after_insert AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_publication();
INSERT INTO message_publication_pending(message_id, room_id)
SELECT id, room_id FROM messages;
COMMIT;
