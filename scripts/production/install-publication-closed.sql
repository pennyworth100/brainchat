-- Owner-only OFFLINE cutover installer. Never run from application startup.
-- Requires completed all-old-writers drain and paired DB/uploads backup.
-- SQL locks protect backfill, NOT files, old images or a recovery point.
-- Existing/partial installations fail; no IF NOT EXISTS or quota reset.
BEGIN;
-- Backfill must see writers that commit while the table lock is awaited,
-- even when the owner's connection default is REPEATABLE READ.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(1145654604, 1);
LOCK TABLE public.rooms, public.messages, public.room_resume_sessions IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid IN ('public.rooms'::regclass, 'public.messages'::regclass,
                  'public.room_resume_sessions'::regclass)
      AND relowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'Publication installer requires the existing table owner';
  END IF;
END
$$;
CREATE TABLE public.message_write_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  used_rows bigint NOT NULL CHECK (used_rows >= 0),
  used_bytes bigint NOT NULL CHECK (used_bytes >= 0),
  max_rows bigint NOT NULL CHECK (max_rows >= used_rows),
  max_bytes bigint NOT NULL CHECK (max_bytes >= used_bytes)
);
INSERT INTO message_write_budget
SELECT true, count(*), COALESCE(sum(octet_length(to_jsonb(m)::text)),0),
  count(*), COALESCE(sum(octet_length(to_jsonb(m)::text)),0) FROM messages m;
REVOKE ALL ON message_write_budget FROM PUBLIC;
CREATE FUNCTION public.admit_message_write() RETURNS trigger
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
CREATE TRIGGER message_admission_after_insert AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION admit_message_write();
CREATE TABLE public.message_publication_pending (
  message_id integer PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id),
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX message_publication_room ON message_publication_pending(room_id, message_id);
CREATE FUNCTION public.enqueue_message_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  EXECUTE pg_catalog.format(
    'INSERT INTO %I.message_publication_pending(message_id, room_id) VALUES ($1, $2)',
    TG_TABLE_SCHEMA
  ) USING NEW.id, NEW.room_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER message_publication_after_insert AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION enqueue_message_publication();
INSERT INTO message_publication_pending(message_id, room_id)
SELECT id, room_id FROM messages;
CREATE TABLE public.publication_subscribers (
 session_id text PRIMARY KEY REFERENCES room_resume_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE public.publication_deliveries (
 session_id text NOT NULL REFERENCES publication_subscribers(session_id) ON DELETE CASCADE,
 message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 generation integer NOT NULL,
 transport_id text NOT NULL,
 delivery_try uuid NOT NULL,
 lease_until timestamptz NOT NULL,
 acked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,message_id)
);
CREATE TABLE public.publication_admission (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO publication_admission VALUES (1);

CREATE TABLE public.publication_snapshot_attempts (
 session_id text PRIMARY KEY REFERENCES publication_subscribers(session_id) ON DELETE CASCADE,
 generation integer NOT NULL,
 transport_id text NOT NULL,
 delivery_try uuid NOT NULL,
 message_ids integer[] NOT NULL CHECK(cardinality(message_ids)<=256),
 lease_until timestamptz NOT NULL,
 acked boolean NOT NULL DEFAULT false
);
REVOKE ALL ON message_write_budget, message_publication_pending,
  publication_subscribers, publication_deliveries, publication_admission,
  publication_snapshot_attempts FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_message_publication() FROM PUBLIC;
-- Refuse ambient ALTER DEFAULT PRIVILEGES grants; explicit runtime grants
-- belong to a separately audited activation, never to this CLOSED installer.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c,
      LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid IN ('public.message_write_budget'::regclass,
      'public.message_publication_pending'::regclass,
      'public.publication_subscribers'::regclass, 'public.publication_deliveries'::regclass,
      'public.publication_admission'::regclass, 'public.publication_snapshot_attempts'::regclass)
      AND a.grantee <> c.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(p.proacl) a
    WHERE p.oid IN ('public.admit_message_write()'::regprocedure,
                   'public.enqueue_message_publication()'::regprocedure)
      AND a.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'Publication installer refuses inherited non-owner grants';
  END IF;
END
$$;
COMMIT;
