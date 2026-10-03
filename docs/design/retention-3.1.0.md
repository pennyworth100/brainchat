# Dimle 3.1.0 — retention and owner-controlled deletion

Status: decision-ready design. This document does not authorize production.

## Product contract

The room creator selects one retention policy when the room is claimed:

| Policy | Meaning shown in the UI | Database value |
| --- | --- | --- |
| 24 hours | Delete 24 hours after the room's last persisted activity | `hours_24` |
| 7 days | Delete 7 days after the room's last persisted activity | `days_7` |
| 30 days | Delete 30 days after the room's last persisted activity | `days_30` |
| Keep until owner deletes | No automatic expiry | `forever` |

The default is **24 hours** for newly claimed rooms. The UI must say that expiry
is measured from the last persisted message or attachment. It must not claim that
deletion is instantaneous: expired rooms are disabled immediately when selected
by the cleanup job and their stored files are then removed asynchronously.

The owner can delete the whole room, a message, or an attachment. Deleting a room
immediately blocks joins and sends. A completed deletion removes database content
and files; it cannot be undone from the product UI.

## Owner authorization

The existing creation token becomes the owner credential instead of being thrown
away after first claim:

1. The server already stores only its SHA-256 hash while the room is unclaimed.
2. On the successful atomic claim, copy that hash to `owner_token_hash` and clear
   `creation_token_hash` in the same update.
3. The creator keeps the raw token in browser session storage as today. It is sent
   only in an `Authorization: Bearer` header to same-origin owner endpoints and is
   never placed in a URL, log, message, or analytics event.
4. Owner operations use constant-time comparison, strict room scoping, JSON-only
   requests, origin checks, and a separate per-IP/per-room rate limiter.

This avoids an account system and a second secret while preserving the current
claim race protection. Losing the token means losing owner controls; the UI must
say this before room creation. A later account-based recovery feature is separate
scope and must not weaken the bearer credential.

## Schema changes

Add to `rooms`:

- `owner_token_hash text null`
- `retention_policy text not null default 'hours_24'` with a database check for
  `hours_24`, `days_7`, `days_30`, or `forever`
- `expires_at timestamptz null`
- `deletion_requested_at timestamptz null`
- `deleted_at timestamptz null`

Add `deletion_jobs`:

- `id bigserial primary key`
- `room_id text not null`
- `message_id integer null`
- `storage_path text null`
- `kind text not null` (`room`, `message`, `file`, `orphan`)
- `status text not null` (`pending`, `processing`, `done`, `failed`)
- `attempts integer not null default 0`
- `next_attempt_at timestamptz not null default now()`
- `last_error text null` (sanitized, no token/content)
- `created_at`, `completed_at`
- a uniqueness key that makes the logical deletion idempotent

Add an index on active room expiry and pending deletion jobs. Change the messages
foreign key to `ON DELETE CASCADE`, while still deleting explicitly in the worker
so file paths can be recorded first.

`expires_at` is computed from the retention policy whenever persisted activity
updates `last_active_at`; it is null for `forever`. Client timestamps never decide
expiry.

## APIs and realtime behavior

- `PATCH /api/rooms/:roomId/retention` — owner only; validates the four policies,
  updates `expires_at`, and returns the effective policy/cutoff.
- `DELETE /api/rooms/:roomId` — owner only; atomically marks deletion requested,
  inserts a room deletion job, disconnects room sockets, and returns `202`.
- `DELETE /api/rooms/:roomId/messages/:messageId` — owner only; tombstones the
  item immediately and queues file removal when applicable.
- `GET /api/rooms/:roomId/retention` — available only after authenticated room
  join; returns policy/cutoff without the owner credential.

All writes require a fresh authenticated room/owner context. A room marked for
deletion returns `410 Gone` from join, sync, send, upload and download paths.
Realtime clients receive `room-deleting` and clear local content.

## Cleanup worker

Use a short-lived Railway cron service that runs every 15 minutes and exits. This
fits the existing platform and avoids a second scheduler library in the web
process. Railway skips a run if the previous invocation is still active, while a
PostgreSQL transaction-level advisory lock protects manual or duplicate runs.

Each run:

1. Marks expired rooms for deletion in a transaction.
2. Claims a bounded batch of jobs with `FOR UPDATE SKIP LOCKED`.
3. Validates every storage path is under the configured upload root.
4. Deletes files idempotently (`ENOENT` is success).
5. Deletes/tombstones database rows and marks jobs done.
6. Retries transient failures with bounded exponential backoff; permanent path
   violations are failed and alerted, never blindly deleted.
7. Emits counts/durations only, with no room secret or message content.

An orphan scan compares storage entries older than one hour with referenced file
messages. It first records an `orphan` job, then uses the same guarded deletion
path. Recent files are ignored to avoid racing an accepted upload.

Existing options considered:

- **Railway cron:** selected; native to the current host, short-lived and free of
  an always-on scheduler dependency.
- **In-process `node-cron`:** rejected; deploys/restarts can duplicate or skip
  work, and every web replica would need coordination.
- **`pg_cron`:** not selected because extension availability is deployment-tier
  dependent and filesystem deletion still needs application code.

## Failure and rollback rules

- Database state is authoritative. A room is unavailable as soon as
  `deletion_requested_at` is committed, even if file cleanup is retrying.
- Never delete the database reference before a file path is durably queued.
- A file-delete failure keeps the job and sanitized error; it does not reactivate
  the room.
- Backups remain governed by the documented backup retention. UI copy must say
  that operational backups may age out separately rather than promise immediate
  erasure from every backup.
- Rollback before enabling cleanup: deploy the old app; additive columns are safe.
- Rollback after enabling cleanup: disable the cron and new endpoints, retain the
  additive schema and jobs for diagnosis. Already deleted data is not restored.

## Security and acceptance matrix

| Threat / failure | Control | Required test |
| --- | --- | --- |
| Guessed owner token | 256-bit token hash, constant-time compare, limiter | wrong token, replay, timing-safe unit test |
| Cross-room deletion | room-scoped authorization in every query | token A cannot mutate room B |
| CSRF / token leakage | same-origin custom header, origin check, no URL/log token | cross-origin request rejected; logs inspected |
| Path traversal | server-generated path plus upload-root containment check | encoded and symlink escape cases rejected |
| DB/file partial failure | durable job before deletion, idempotent retry | injected filesystem and DB failures converge |
| Duplicate workers | advisory lock, `SKIP LOCKED`, uniqueness key | concurrent workers process each item once |
| Active-room expiry race | server-side activity transaction and cutoff | message at cutoff extends room exactly once |
| Orphan race | minimum age and DB-reference recheck | in-flight upload is retained |
| Misleading privacy copy | explicit last-activity cutoff and backup caveat | UI/API copy review |

## Implementation slices

1. **3.1.0-a — schema and owner credential:** additive migration, claim transfer,
   authorization helper, unit tests, no cleanup enabled.
2. **3.1.0-b — policy API and UI:** retention selection, cutoff display, owner
   controls, cross-room authorization tests.
3. **3.1.0-c — deletion jobs:** tombstones, room/message/file endpoints, guarded
   storage deletion, injected-failure integration tests.
4. **3.1.0-d — Railway cleanup:** bounded worker, advisory lock, cron staging,
   metrics and orphan scan dry-run first.
5. **3.1.0-e — audit and production:** staging soak, restore drill, security review,
   privacy-copy acceptance and Max's explicit production approval.

## References

- Railway cron jobs: https://docs.railway.com/cron-jobs
- PostgreSQL explicit/advisory locking: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL `DELETE ... RETURNING`: https://www.postgresql.org/docs/current/sql-delete.html

