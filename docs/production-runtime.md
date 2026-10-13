# Explicit production runtime composition

`production-runtime.ts` exports `startProductionRuntime`. It is the nonmigrating
runtime half of the trusted cutover controller, not a standalone deployment
command and not proof of release acceptance. `npm start` still runs migrations;
do not substitute it for this entrypoint during production cutover.

The caller supplies explicit production runtime/maintenance URLs, verified CA,
a live verifier and, when authorized, the paired strict upload configuration.
No migration URL, migration pool, role reopening or capacity provisioning occurs
in this module. Ordinary DATABASE_URL and candidate credentials are not used.
The verifier runs before application filesystem creation or listener startup;
it must return a live lease with `assertHeld()`. Both actual runtime identities
are independently verified between fresh lease assertions before filesystem work.
Missing or rejected verification fails closed. A no-op callback is not valid
production authorization.

After Next/provider preparation, the runtime rechecks that SAME captured lease
and the actual database identities immediately before binding HTTP. It never
calls the verifier again to obtain a replacement lease. Pending or rejected
final checks do not expose a listener. A settled startup rejection closes both
authority pools only after lifecycle, strict storage, Socket.IO and Next cleanup;
failed or unverifiable cleanup still retains them for operator recovery. This
does not implement continuous post-listen monitoring or the controlled database
NOLOGIN-to-ACTIVATING transition: the release controller still owns those gates.

The controller must retain its ORIGINAL dedicated operator connection and fence
through all fresh release/catalog/ACL/adoption/capacity gates, this call, and
readiness/cutover. This module does not implement that controller or extend the
life of its fence. Never use a saved PASS JSON as a verifier. Null strict storage
still leaves attachments unavailable, not an acceptable full-release gate.

The returned `stop()` synchronously fences admission, retains one promise, waits
for lifecycle and strict-upload settlement, closes HTTP/Next and only then both
pools. The process owner installs its signal handler; calling the function does
not install one. Failed startup with unconfirmed application settlement
conservatively retains authority pools for operator recovery.

Acceptance: `scripts/qa-upload-ledger-tls-fixture.py --candidate` invokes the real
module against an owned disposable TLS/SCRAM PostgreSQL cluster. It covers a
pending/rejected controller, post-gate privilege drift, lease loss after identity
checks and immediately before listening (including pending/rejected final gates
and late privilege drift), no migrator credentials,
unchanged migration history/CLOSED budget, real HTTP room creation and settled
shutdown. This is not managed-platform acceptance or physical storage authority.
