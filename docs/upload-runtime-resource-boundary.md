# Credential-bearing upload boundary (draft 3.0.11)

`POST /api/upload` with either resume credential header selects the strict
branch. Framing and bearer/session/owner authentication run before the body.
Malformed framing returns 400; invalid credentials return 403. There is no
fallback to socket-ID authority when either credential header is supplied.

**Even valid credentials now return 503 `UPLOAD_RESOURCE_UNAVAILABLE`.** The
application has no installed, audited physical-resource admission and bounded
parser/storage/receipt composition. Authentication alone must not enter the
legacy Multer writer. This is a closed activation gate, not a working resource
reservation implementation. Environment flags, policy rows or arithmetic quotes
cannot enable it. No new configuration toggle or request-selected policy exists.

The unused in-memory session grant is released synchronously before responding:
no resource reservation, parser or storage operation has started. This is not
permission to release a future in-flight reservation on HTTP close, timeout or
unknown COMMIT. That future path must retain liability until actual settlement.

Requests with neither header still use the existing legacy compatibility path.
Its upload authorization/lifetime regression remains covered separately. This
change does **not** establish an all-writer fence or secure that credentialless
path, issue credentials to browsers, enforce physical quotas, or make the draft
release production-ready. No product UI currently sends these resume headers.

## Required before opening the gate

- Trusted project, environment, service, volume **instance** and upload-root
  binding; shared volume IDs alone do not identify the mounted quota domain.
- Audited whole-domain baseline/headroom/costs and an exclusive-writer cut,
  including old replicas and legacy writers. Do not infer these from statfs or
  provider-reported size fields.
- Scoped verified database authority and canonical domain-lock transaction;
  only acknowledged reservation COMMIT can precede parser/first filesystem work.
  Missing/disabled/unverified/mismatched policy, exhaustion and uncertain COMMIT
  remain fail-closed without legacy fallback, refund or automatic retry.
- Bounded multipart, storage, file writer and durable receipt composition with
  ownership retained through actual parser/storage/transaction settlement.
- Coherent public credential activation and removal of the credentialless
  bypass; real HTTP/PostgreSQL/physical acceptance and exact-release audit.

## Executable evidence

`scripts/qa-public-session-fixture.py` starts the actual server and a disposable
PostgreSQL cluster. `qa-public-session.ts` sends valid multipart headers without
a body twice: each gets 503 without waiting for body bytes, showing that denial
does not leak the unused grant. A complete multipart request is also denied.
Upload directory inventory and message count remain unchanged; both existing
upload-accounting tables and all three resource tables remain empty. Separate
legacy multipart tests still check revocation/generation/expiry/policy changes,
disconnect settlement and single-upload concurrency against the real server.
Existing PostgreSQL rate-limit counters can still be charged on denied requests;
this proof does not claim the request performs no database writes whatsoever.
