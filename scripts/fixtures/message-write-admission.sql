-- PRIVATE, append-only admission prototype. NOT a startup migration.
-- Logical rows/UTF8 JSON envelope bytes, NOT PostgreSQL disk/WAL allocation.
-- Installer must be a trusted schema owner; runtime must NOT own these objects.
BEGIN;
LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE message_write_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  used_rows bigint NOT NULL CHECK (used_rows >= 0),
  used_bytes bigint NOT NULL CHECK (used_bytes >= 0),
  max_rows bigint NOT NULL CHECK (max_rows >= used_rows),
  max_bytes bigint NOT NULL CHECK (max_bytes >= used_bytes)
);
-- Start CLOSED at the exact existing population; no guessed production quota.
INSERT INTO message_write_budget
SELECT true, count(*), COALESCE(sum(octet_length(to_jsonb(m)::text)),0),
  count(*), COALESCE(sum(octet_length(to_jsonb(m)::text)),0) FROM messages m;
REVOKE ALL ON message_write_budget FROM PUBLIC;
CREATE FUNCTION admit_message_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE accepted boolean;
BEGIN
  EXECUTE pg_catalog.format(
    'UPDATE %I.message_write_budget SET used_rows=used_rows+1, used_bytes=used_bytes+$1
     WHERE id AND used_rows < max_rows AND $1 <= max_bytes-used_bytes RETURNING true',
    TG_TABLE_SCHEMA
  ) INTO accepted USING pg_catalog.octet_length(pg_catalog.to_jsonb(NEW)::text)::bigint;
  IF accepted IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'message write capacity exhausted' USING ERRCODE='53100';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION admit_message_write() FROM PUBLIC;
-- AFTER means ON CONFLICT DO NOTHING retries do not spend capacity.
-- Both charge and journal insertion roll back with the enclosing transaction.
CREATE TRIGGER message_admission_after_insert AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION admit_message_write();
COMMIT;
