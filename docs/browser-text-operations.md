# Browser text operation ownership (3.0.26)

The room editor allocates an immutable clientMessageId before synchronizing or
sending. An uncertain ACK retains the exact key and payload in a bounded,
in-memory operation map, including when the user edits another draft.

A manual retry is permitted only on the original physical connection and the
same room-session controller, after the server explicitly advertises
textOperationKeys in its authenticated join snapshot. The server's existing
durable text operation gate returns the original receipt without another row
or recipient fanout. A verified receipt retires the pending operation; an
intentional second send of identical text then receives a new key.

An ordinary reconnect still creates a new logical server session. Replaying
the same key there would NOT deduplicate against the old session. Accordingly
this release blocks uncertain retries across reconnect; it does not claim
durable browser resume. Socket emits are volatile to prevent transport buffering
from silently flushing an old operation into a newly joined session.

Old servers do not advertise the capability. First-attempt sends and legacy
success receipts remain supported; uncertain retries remain blocked. No public
resume token or session identifier is exposed by this change.

Pending operations have a hard limit of 32; uncertain entries are never evicted
or expired to admit another write. They are memory-only and do not survive a
page reload. Reloading, another device, or deliberately changing the payload
is not an exactly-once guarantee. No automatic resend is introduced.

## Remaining release gates

Coordinated browser credentials/resume and receipt reconciliation across
reconnect, image/file upload identities, browser/device acceptance, trusted
runtime provider ownership and shutdown, physical byte+inode authority, and
fresh paired recovery/cutover proof remain required for PR #20.

