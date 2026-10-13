# Retained operator fence (3.0.48)

`acquireWriterFence` and `acquireAndAuditWriterFence` return an `assertHeld()`
closure bound to the original dedicated client, backend PID and exact
`backend_start` text. Adoption asserts it before and after the restricted-owner
audit and restoration of operator identity.

Each assertion checks the original two-key exclusive session lock, target and
operator identity, fresh isolated role OIDs/privileges/membership, allowed reader,
background/prepared writers, NOLOGIN flags and absence of other writer backends.
It never acquires a replacement lock, drains new sessions or changes role flags.
Error, disconnect, overlapping assertions or a failed observation permanently
invalidate that handle; correcting a role or reacquiring a lock cannot revive it.
A fresh acquisition is a NEW fence, not continuity of earlier audit evidence.

This is a trusted operator primitive, not an activation token or a production
launcher. Callers must exclusively own the client, serialize their entire audit
and activation workflow and keep the session alive throughout. Assertions cannot
prove an unobserved unlock/relock or trusted administrator mutation between calls.
Do not multiplex the client or unlock it; repeat all release checks after loss.
Catalog/owner/ACL lineage, finite capacity, physical uploads, paired backup and
the final FENCED-to-ACTIVATING transition still require implementation/evidence.
No error path reopens any role; `activationAuthorized` remains false.

Owned PostgreSQL tests exercise actual role drift, expiry, unexpected backends,
lock loss and reacquisition, a real replacement backend owning the same lock,
overlap and disconnect. CI runs these fixtures on PostgreSQL 16 and 18.
