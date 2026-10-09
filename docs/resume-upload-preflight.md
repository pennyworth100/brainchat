# Private pre-body upload authentication (3.0.10 draft)

NOT wired to HTTP or multer. No public upload behavior, version, schema or dependency
change. This is one bounded prerequisite, not complete resume or HTTP acceptance.

## Implemented seam

`ResumeMemberships.bindingFor` resolves the exact installed binding from an actual
server Socket and its exact server-owned owner. Wrong room, copied owner, unrelated
socket, uninstalled membership, expiry, close and replacement fail closed.

`preflightResumeUpload` snapshots room/session/token before asynchronous work.
Malformed tokens and local identity mismatches deny before DB. A non-mutating
`ResumeStore.lookup` authenticates the bearer and checks durable room policy,
revocation and DB-clock expiry. Its result must match the exact live binding's
session, room, username, policy, generation and absolute expiry. The physical owner
is rechecked AFTER lookup, immediately before opaque upload admission. There is no
client-built binding, source, filesystem, CAS, broadcast or automatic retry.

Shared per-socket exclusion and a process-wide 100-lookup budget prevent overlapping
wrappers bypassing pending work. A monotonic deadline of at most 10 seconds fences
late results; lookup errors propagate. Lookup is NOT cancelled or released at the
deadline/close. It stays pending until actual settlement, retaining both permits.
The HTTP layer must reject/close its transport without claiming cancelled DB work.

A successful grant retains the existing bounded upload lifetime after ordinary
disconnect. Disconnect BEFORE admission denies. Successor/policy/expiry checks in
the durable upload transaction remain mandatory: preflight lookup is not a lock,
and policy can change after it returns. No new grant allows live socket fanout.

## Before public activation

The current server's x-socket-id + x-room-id check is NOT bearer authentication:
a socket ID can be learned from user presence. It must not be copied into this
new path as proof of identity. Resolve socket/owner from an authoritative server
registry, verify the resume bearer through this seam, and never log bearer headers
or place tokens in URLs. No public route or owner registry is added here.

Order: strict bounded headers and request framing; credential preflight and
rate/admission/disk reservation; only then instantiate or consume multipart parser;
exclusive staging; durable file receipt; current-owner/recipient-fenced publication;
final lease release only after all actual source/file/DB work settles.

Still required (NOT implemented/proven by this seam):

- Explicit multipart bounds: one file, bounded part/header/name/MIME counts and
  sizes, no unbounded fields; strict Content-Type/framing handling and total request
  byte limits including multipart overhead. Content-Length is not authority.
- Bounded Node/proxy/socket/parser buffering, serial backpressure into the existing
  sink, request/body deadlines and tested abort/finalization semantics. An HTTP
  framework or proxy may receive/buffer bytes before application authentication;
  rejection before parser/source/FS does not mean zero network bytes received.
- Aggregate and per-session rate limits, including denied auth attempts. The
  lookup capacity is concurrency control, not a request-rate limit.
- Disk-byte reservation/quota and headroom checks before parser/staging, accounting
  for concurrent attempts, metadata/inodes and retained uncertain files. A 100
  slot count times 100 MiB is not a disk quota. Reservation cannot be refunded on
  timeout alone or before settlement/reconciliation.
- Durable attempt provenance plus reconciliation across process crashes, COMMIT
  uncertainty and retries. Never delete by age or blindly unlink a retry/original
  path; require proof that every relevant receipt/attempt cannot reference it.
- Public error mapping, Origin/CSRF and CORS policy, TLS, secret redaction, real
  HTTP rejection tests before parser/FS, disconnect/replacement races and fault
  tests across all finalizers. Eight loopback lifecycle regressions added here
  stub the DB authentication result; existing real DB lookup tests are separate.
