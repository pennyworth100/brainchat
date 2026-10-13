# Server-owned strict upload runtime — 3.0.21

The authenticated HTTP branch now calls one server-owned StrictUploadRuntime.
Its storage is explicitly null in server.ts: production activation is still
unavailable (503), with no request-source/parser/accounting/storage entry.
Legacy Multer is never a fallback. No environment flag enables synthetic permits.

When a future audited deployment supplies StrictFileStorage, this composition
validates framing and the bounded x-client-message-id header, constructs a
dormant native HTTP source, then awaits StrictMultipartUpload: accounting,
physical authority, bounded parser, durable storage, and DB receipt settlement.
It releases the volatile upload admission only after that promise settles.
It never refunds durable accounting or removes files.

ServerLifecycle retains the runtime as an owner, in addition to tracking the
complete HTTP handler (including post-commit publication). Shutdown closes new
runtime admission and awaits in-flight work. Duplicate invocation with the exact
same grant waits for the original promise, then denies; it cannot release a
pending lease or give a second publisher the successful insert receipt.

Authorized insert returns its durable message and broadcasts once. A DB replay
returns its receipt without broadcasting. Unknown COMMIT returns 500 /
UPLOAD_OUTCOME_UNKNOWN; not-dispatched returns 503 / UPLOAD_NOT_COMMITTED.
Neither is permission to retry a previous ambiguous attempt. Post-commit
activity/notification/response failures do not turn durable success into rollback.

Remaining activation gates: genuine physical byte AND object authority, exact
strict-root download mapping (never expose the backup parent), browser credential
and stable retry identity integration, deployment audit and paired recovery.
No deployment or physical-capacity evidence is supplied by this patch.
