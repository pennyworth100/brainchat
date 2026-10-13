# Controlled operator admission (3.0.51)

`acquireWriterFence().beginActivation({verifyRelease, verifyCapacity,
verifyRecovery})` is an explicit trusted-operator primitive, not a deployment
command. It captures all three **live verifier functions**, serializes them,
and brackets each with assertions on the original operator PID, backend_start,
session advisory lock, identities, role expiry, reader and background writers.
Saved PASS objects and missing verifiers are rejected. All three run while all
writers remain NOLOGIN and drained. Only then does one transaction enable
runtime and maintenance LOGIN. Owner/migrator stays NOLOGIN. No quotas, expiry,
credentials, grants or migration history change.

The returned ACTIVATING lease asserts the same session and authority, now
permitting runtime/maintenance client backends. These isolated role credentials
must remain exclusively controlled; the primitive does not distinguish two
processes using the same credential. It cannot defend against a trusted admin.
Pass this same lease to `startProductionRuntime` and retain it through readiness
and cutover. Never reacquire a replacement inside a verifier.

Gate failure poisons the handle without opening admission. An error during or
after the LOGIN transaction attempts containment on the original session:
NOLOGIN all three pinned role OIDs and drain their pinned writer backends. If
session/lock continuity or containment cannot be confirmed, the error explicitly
reports **containment UNCONFIRMED**; it never silently reconnects. The controller
must stop runtime admission and use an independently authorized containment
path when the original session is unavailable. `closeAdmission()` also allows
explicit containment of an already-poisoned lease, but cannot revive it.
Runtime settlement should precede planned containment. There is no automatic
post-listen monitor, routing switch or recovery orchestration in this primitive.

Owned PG18 acceptance exercises real role admission, gate rejection, gate-time
expiry/lock loss, overlap, owner login denial, runtime/maintenance connections,
unknown backend rejection, drain and committed-transaction ACK loss. The owned
TLS/SCRAM runtime fixture carries the original operator through the real runtime
identity checks, final listener gate, HTTP readiness and settled shutdown.
Its test gates deliberately retain a CLOSED message budget and no physical
uploads: **not managed release/capacity/backup/recovery acceptance**.

The managed controller still must implement the exact fresh catalog/ACL,
finite message policy, physical byte/object authority, actual strict adapter,
paired backup/recovery gates and routing rollback. Do not wire fixture verifiers
or no-op callbacks into deployment. `npm start` still uses legacy migrations;
this change does not authorize launching it as the production controller.
