# Transitional HTTP upload authority (3.0.11 draft)

The actual server route resolves the exact server-owned Socket, owner and
logical membership after rate charging, then durably authorizes the session
before Multer/filesystem allocation. There is no onlineUsers authorization map
or Socket.IO room-join projection.

Pre-body lookup allows one unresolved authorization per socket and 100 per
server. A result arriving after 10 seconds denies admission; unresolved work
retains capacity until actual settlement. No cancellation is implied.

## Admitted lifetime and persistence

At parser handoff the route captures an opaque ResumeUploadAdmissions grant:
one per session, at most 100 aggregate, with a 120-second monotonic deadline.
Disconnect alone does not invalidate an admitted upload. The actual file INSERT
runs through ResumeUploadOperationGate, checking durable revocation, generation,
transport, identity, expiry and room policy before AND after the write while
holding the gate transaction locks. It never uses the socket-active predicate
for accepted upload persistence.

The settled parser-error callback or handler finalizer releases the grant.
HTTP/socket close alone cannot release unresolved parser/DB work. Grant expiry
fences persistence but does not cancel Multer or bound stalled transport.
A parser that never settles retains its slot. Deferred room touch remains after
COMMIT, outside the room SHARE lock; no lock-upgrade deadlock is introduced.

Denied persistence returns 403, not the existing client's retryable 401.
Unknown persistence outcomes retain bytes and do not automatically retry.
Post-save notification/response failure cannot invalidate persistence. Neither
denial nor capacity release authorizes deletion; no reclamation claim is made.

## Remaining release gates

- Requests without credential headers still use x-socket-id as the legacy HTTP
  bearer capability, not independent caller authentication. Requests supplying
  either x-resume-session-id or x-resume-token now MUST pass strict framing and
  credential-authenticated preflight; no invalid/partial credential falls back.
  Tokens authenticate via the durable store and must match the exact live owner.
  Denial is 403 (framing 400), before parser/FS. Credentials are not issued publicly
  yet; legacy removal and browser credential use remain release gates.
- Multer/raw body framing, resource-ledger reservation and receipt/idempotency
  composition remain to be integrated. This is not the completed upload pipeline.
- Public resume and credentials remain unexposed. Keep the release draft.

## Evidence

qa-public-session.ts runs actual server.ts + HTTP + owned PostgreSQL. It proves
pre-body denial without filesystem allocation and pauses real multipart AFTER
storage starts: revocation/generation/expiry/policy changes prevent INSERT,
while an admitted disconnect persists once. Concurrent same-session bodies deny
without allocation; a settled denial releases the permit.
These paused-body cases now exercise the credential-bearing route. Additional
actual HTTP cases prove partial/forged/wrong-session/wrong-owner credentials,
durable pre-body revocation/generation/expiry and invalid framing fail without
filesystem effects or legacy downgrade. The disposable DB fixture installs a
known token hash; it does not add a production credential-issuance endpoint.
The full reconnect/upload regression covers parser limits, legacy responses,
byte/path integrity and admitted-before-disconnect persistence/fanout/rejoin.
qa-public-upload-outcome.ts extracts the real route/storage via AST but
substitutes admission, transaction gate and emitter: its injected autocommit
faults prove byte retention, NOT actual gate COMMIT fault behavior.
