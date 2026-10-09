# Private pre-body upload authentication (3.0.11 draft)

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

Separate shared fixed-window attempt budgets now run before durable lookup:
1200 calls/minute process-wide and 60 calls/minute per authoritative logical
session, with at most 10,000 session debt records. Aggregate quota is charged
even for malformed/unowned calls. A session key comes ONLY from the exact current
physical owner/membership, before checking request room/session/token. Wrong-room,
malformed, forged bearer, pending/capacity denial and DB errors do not refund debt.
No request, wrapper, admission object, reconnect or generation change resets it.
Expired windows are pruned without live-debt eviction; clock rollback is clamped,
non-finite readings fail closed. These are fixed windows, not rolling limits:
adjacent window boundaries can allow two bursts. No timers or automatic retry.

These private defaults are process-local and reset on process restart. They do
not protect against distributed/IP abuse or allocation before this seam. A caller
who knows a victim socket ID can consume its local quota even without a valid
bearer; upstream network/IP controls remain required. A closed/unowned socket
consumes only aggregate quota. No upload grant lifetime or disk accounting changes.

A successful grant retains the existing bounded upload lifetime after ordinary
disconnect. Disconnect BEFORE admission denies. Successor/policy/expiry checks in
the durable upload transaction remain mandatory: preflight lookup is not a lock,
and policy can change after it returns. No new grant allows live socket fanout.

## Before public activation

`validateResumeUploadFraming` is a separate PRIVATE synchronous header prerequisite,
not yet wired to this preflight or any route. It requires HTTP/1.1 POST, one positive
canonical Content-Length (at most 100 MiB + 64 KiB envelope overhead), and one strict
multipart/form-data boundary (1..70 ASCII characters). It scans rawHeaders, not
Node's normalized map which can discard duplicate Content-Type. Duplicate framing
headers, any Transfer-Encoding, Content-Encoding, Expect or Trailer fail closed.
All header pairs (at most 64) count toward an 8192-byte application header budget;
invalid names/control characters and non-Latin-1 request-shaped values deny.
The accepted boundary is deliberately a narrow RFC-compatible subset; no extra
parameters, quoted escapes or embedded spaces. The result is an immutable snapshot.

No parser, body stream, authentication or filesystem is touched by this helper.
The future HTTP adapter MUST call it before parser creation, and separately handle
Node's checkContinue/checkExpectation (Node may otherwise send 100 Continue before
the request handler), header timeouts and parser-level maxHeaderSize. The declared
length is NOT body validation or a memory/disk reservation. Total streaming bytes,
multipart syntax/parts, file bytes, actual Content-Length agreement and aborts still
need enforcement. A loopback raw HTTP test proves Node hides duplicate Content-Type
in normalized headers while this helper rejects the original pairs. It is NOT a
public endpoint test or proof of zero network buffering.

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
- Upstream connection/IP/header-abuse controls and distributed rate policy. The
  private process/session attempt budgets do not replace those protections.
- Disk-byte reservation/quota and headroom checks before parser/staging, accounting
  for concurrent attempts, metadata/inodes and retained uncertain files. A 100
  slot count times 100 MiB is not a disk quota. Reservation cannot be refunded on
  timeout alone or before settlement/reconciliation.
  The separate [durable reservation ledger](resume-upload-reservation.md) now
  provides atomic byte accounting and attempt provenance, but is NOT connected
  to this preflight, admission or storage. Actual headroom remains unproven.
- Durable attempt provenance plus reconciliation across process crashes, COMMIT
  uncertainty and retries. Never delete by age or blindly unlink a retry/original
  path; require proof that every relevant receipt/attempt cannot reference it.
- Public error mapping, Origin/CSRF and CORS policy, TLS, secret redaction, real
  HTTP rejection tests before parser/FS, disconnect/replacement races and fault
  tests across all finalizers.

## Integration evidence

The eight local loopback lifecycle regressions stub the DB authentication result.
The isolated PostgreSQL CI harness now additionally composes real Socket.IO
connections, actual owner admission/membership, and actual ResumeStore lookup.
It checks an exact-binding grant; same-length forged bearer, wrong room,
revocation, expiry, policy change and a durable successor with stale local state.

An ACCESS EXCLUSIVE fixture-table lock blocks the actual lookup SELECT; observed
pg_stat_activity lock wait (not an elapsed sleep) gates owner close/replacement.
The controller performs the successor CAS on its own lock-holding transaction;
membership is installed before that isolated fixture transaction commits. The old
read must return no grant and cannot redirect to the successor. A separate close
case preserves durable identity and physical connectivity, isolating the local
owner fence. A fresh lookup at the successor must grant its exact generation.
The body-boundary counter is a harness assertion, not proof about a public HTTP
parser, network buffering or a running production route.
