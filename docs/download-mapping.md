# Download mapping — 3.0.22

The public /uploads handler no longer mounts the entire upload parent as an
unrestricted static namespace. Legacy URLs retain the production writer's
16-lowercase-hex token plus one sanitized filename (including report..pdf).
Other directories, nested paths, indexes and backup-parent paths are denied.

Strict 64-lowercase-hex /blob URLs never fall through to the legacy root.
Production wiring supplies a null source and returns 503 without filesystem or
publication lookup. This does NOT enable authenticated uploads or provision a
physical capacity provider.

The optional trusted strict source binds the exact opaque root/policy/limit and
a server-owned lookup of committed visible file metadata. Directory existence,
a staged file, charge, pending SQL or unknown commit are not publication.
The reader validates the exact root identity before lookup and after opening,
rejects symlinks, hardlinks, ownership/mode/device/size mismatches and non-files,
and streams the validated descriptor with attachment/nosniff headers. FIFO open
is nonblocking. GET and HEAD only; no Range optimization in this initial mapping.
Metadata digest is validated syntactically, not rehashed on every download.

Prerequisites remain the writer/root API's stable exclusive ancestors, no hostile
same-uid mutation and immutable published files. This is not openat confinement.
No deletion, migration, retry, refund, dependency or production configuration change.

## Evidence

Real HTTP tests exercise exact strict vs legacy-root collisions, GET/HEAD,
unavailable provider, unpublished/mismatched receipts, backup/traversal/encoding
denials, size/mode/hardlink/symlink/root-replacement checks, unsupported methods,
copied root capability, lookup failure, FIFO and concurrent descriptor closure.
Synthetic root-policy values are fixture-only, NOT production physical authority.

## Remaining activation gates

Install a trusted committed-message lookup and exact root binding paired with the
upload writer. Strict reader lifetime is now retained by the server shutdown owner
(see download-drain.md, 3.0.23). Establish the real cumulative byte+inode contract,
dedicated accounting-pool ownership and browser credentials/stable retries.
Then audit the exact image, take fresh paired backups at a proven old-writer
fence, deploy within Max's existing authorization and verify readiness/rollback.
