-- PRIVATE prototype, installed only in disposable acceptance databases.
-- Never delete global publication records on emit or subscriber ACK.
CREATE TABLE publication_subscribers (
 session_id text PRIMARY KEY REFERENCES room_resume_sessions(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE publication_deliveries (
 session_id text NOT NULL REFERENCES publication_subscribers(session_id) ON DELETE CASCADE,
 message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 generation integer NOT NULL,
 transport_id text NOT NULL,
 delivery_try uuid NOT NULL,
 lease_until timestamptz NOT NULL,
 acked boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,message_id)
);
-- Serialize bounded subscriber admission, never silently evict a live subscriber.
CREATE TABLE publication_admission (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO publication_admission VALUES (1);

-- One retained full-cut attempt per subscriber, including the empty set.
-- PRIVATE only: no startup migration or public READY authority.
CREATE TABLE publication_snapshot_attempts (
 session_id text PRIMARY KEY REFERENCES publication_subscribers(session_id) ON DELETE CASCADE,
 generation integer NOT NULL,
 transport_id text NOT NULL,
 delivery_try uuid NOT NULL,
 message_ids integer[] NOT NULL CHECK(cardinality(message_ids)<=256),
 lease_until timestamptz NOT NULL,
 acked boolean NOT NULL DEFAULT false
);
