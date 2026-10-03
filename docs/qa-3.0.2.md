# Dimle 3.0.2 — reconnect and attachment recovery

Status: candidate only. No merge, production deployment, or physical-iPhone PASS.
Base: production v3.0.1, `a8db5b724227062d8b3a3e5756e91fec1c402afb`.

## Evidence and diagnosis

The reported live failure had an iPhone stopped at 10:39 while a desktop had
messages through 10:46, both showing “3 online”. A PDF upload failed; a previous
photo upload had succeeded. These remain distinct from earlier scoped PASS runs.

In v3.0.1, Socket.IO transport reconnection did not issue another authenticated
`join-room`; history and presence were not refreshed on resume. Upload auth used
the transient socket ID. HTTP upload success also needed a separate `send-file`
event to persist and publish the attachment. These are confirmed code-level gaps.
The claim that this particular PDF caused the original disconnect is **unproven**.
The original PDF and physical device have not been independently reproduced here.

## Patch

- Retain join credentials only in component/session memory, rejoin after transport
  reconnect, and require an authenticated room snapshot before enabling sends.
- Probe and resync on pageshow, visibility return, online, focus, and every 15 s
  while visible. Probe failure recreates the socket and rejoins with credentials.
  Healthy probes do not consume password-attempt/join rate limits.
- Display Syncing/Reconnecting instead of stale online counts. Reconcile current
  history and live events by persisted message ID; preserve already displayed
  messages and do not scroll on an unchanged snapshot.
- Text gets a persistence acknowledgement; keep the draft when unconfirmed.
  DMs attempted while disconnected keep their draft too.
- Before uploading, verify room readiness and obtain the current socket ID.
  Retry once only on an explicit 401 (rejoin first), not on ambiguous failures.
  Explain size/rate/auth/network errors; cap upload wait at 120 s.
- Authenticate before reading upload bytes, then persist and publish from HTTP.
  A socket loss during the accepted upload no longer strands the attachment.
  Merge the response, broadcast and history by the same server ID.
- Preserve v3.0.1 HTTP response fields. Ignore its now-redundant `send-file`
  notification, preventing duplicate file messages.
- Keep the existing 100-message server history window and 100 MiB upload limit.
  Recovery guarantees the current history window, not unlimited backlog replay.

## Verification (local, isolated database)

- Unit/regression suite: **11/11 PASS**.
- TypeScript: **PASS**. Production build: **PASS**.
- Actual HTTP/Socket.IO/PostgreSQL integration: **6 grouped scenarios PASS**:
  rejoin/backfill/dedup/presence; unauthorized history/upload and stale-ID rejection;
  synthetic 2 MiB PDF byte-for-byte round trip; rejected upload followed by text;
  socket loss during accepted multipart upload; v3.0.1 wire-protocol compatibility.
- Mobile WebKit with iPhone 13 emulation: **3 grouped scenarios PASS**:
  offline/resume with deduplicated history and both-way messaging; PDF upload,
  recipient display and matching download; explicit rejected-PDF error followed
  by working text in both directions. No page errors. Unchanged resync preserves
  scroll position. This is **not** a physical-iPhone test.
- No production room, production database, or room 0000 used in these tests.

Reproduce with a dedicated local database, not production credentials:

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
# In a separate terminal, with a dedicated local PostgreSQL database:
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/dimle_qa \
  UPLOAD_DIR=/tmp/dimle-qa-uploads PORT=3302 NODE_ENV=production npm start
QA_BASE_URL=http://127.0.0.1:3302 node --import tsx scripts/qa-reconnect-upload.ts
# Optional: provide an existing Playwright module with WebKit installed.
QA_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node scripts/qa-mobile-webkit.mjs
```

The scripts refuse non-loopback targets. Browser tooling was installed outside
the application and adds no production dependency. Database initialization and
server startup are explicit; do not point the scripts at an existing shared DB.

## Physical-iPhone acceptance still required

Use this exact candidate build in an explicitly authorized environment. A pushed
branch does not update www.dimle.com. Live remains v3.0.1 until a separately
approved deployment; do not retest the old live build and label it 3.0.2.

1. Join the same test room on desktop and the physical iPhone. Note both versions,
   environment/database and the room ID. Leave room 0000 untouched.
2. Background the iPhone / open Files; interrupt networking while desktop sends
   timestamped messages. Resume. Confirm syncing state, refreshed participants,
   every message in the current history window, and no duplicates, without reload.
3. Send text from each side after recovery.
4. Upload the original reported PDF. Record its byte size and any exact error.
   Confirm one attachment on each side, download, and compare the original bytes.
5. Repeat with a deliberately failed upload, then text in both directions.
   Also interrupt the socket during an upload and check server completion/history.
6. Report PASS/FAIL separately by criterion. Keep the original failure report and
   previous scoped PASS evidence intact. No implied merge/deploy approval.

## Existing-library choice

Uses the existing Socket.IO reconnect lifecycle and acknowledgement APIs; no new
realtime framework or client dependency. Background probe/backfill implements the
application room semantics that transport reconnection alone does not restore.
References: [client lifecycle](https://socket.io/docs/v4/client-api/),
[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/).
