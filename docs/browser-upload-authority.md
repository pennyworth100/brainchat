# Browser upload authority — 3.0.28

The upload client now requires an explicit room/transport-bound authority from
its session controller. Missing authority, partial bearer credentials, mismatched
room/transport and mixed legacy/bearer shapes fail BEFORE FormData/HTTP. There is
no missing-header fallback. The current public room controller deliberately
returns only legacy authority for its exact ready room and current transport.

The private resume branch supplies all three headers: session ID, token and one
random operation key. A successful strict receipt must match that key and file
metadata and contain a canonical local strict download path. The server runtime
carries the key captured before parsing/persistence into the HTTP response; it
does not reread or blindly echo a header after asynchronous work.

Only explicit legacy pre-body 401/UPLOAD_AUTH_REQUIRED can reconnect once.
Authority is re-read after that reconnect; changing room or credential mode
fails closed. Strict failures, unclassified 401, unknown commit, lost response
and malformed receipts NEVER reconnect, downgrade or automatically replay.

## Limits / next gate

This is the upload slice of coordinated browser migration, NOT public resume
activation, cross-reconnect retry or a durable outbox. A key lives only for this
invocation. Manual re-selection is still a new operation; pending upload
ownership and receipt reconciliation remain to be implemented. HTTP responses
are authenticated by the origin/TLS, not cryptographically verified client-side.
No credentials are stored, logged, advertised or issued to the browser here.

Before public resume, the same controller must own credentials and generation
CAS across reconnect/sync/text/image/file, keep pending operation identities and
reject partial capability bundles. Actual browser multipart compatibility,
device acceptance, physical byte+inode authority, capacity/expiry, exact-image
audit and fresh paired backup at the old writer fence remain release gates.
Strict storage remains unprovisioned; production/staging/listener unchanged.
