# Upload no-downgrade policy — candidate 3.0.12

Parent: b48fdad (PR #20 candidate 3.0.11). This is a stacked correction,
not authorization to merge the unfinished resume release into main.

The exact authenticated normal-join binding is the only server-owned legacy
upload authority. Resumed owners never receive it. Successful durable upload
bearer authentication permanently marks that physical owner strict, even when
resource admission is unavailable or the subsequent in-memory grant is denied.
Invalid/partial/wrong-owner credentials cannot change another owner's policy.
Join ACK retries and reconstructed admission wrappers cannot reset the policy.

Both the HTTP route and LegacyUploadAdmission consult this policy. The latter
rechecks after asynchronous database settlement; the route rechecks at parser
handoff. An already admitted legacy upload retains its existing settlement
contract. The upload route no longer invokes express.json: no upload handler
uses JSON bodies, and a forged JSON content type must not delay authorization.

Strict missing credentials return 403. Valid strict credentials still return
503 UPLOAD_RESOURCE_UNAVAILABLE before multipart/parser/storage. Untouched
normal joins retain legacy compatibility. Reconnect/resume is strict; a fresh
password-authenticated normal join remains a distinct legacy operation.
There is no durable room-wide strict policy or public credential issuance yet.
Those, physical byte/inode authority, bounded storage/receipt composition and
unknown-outcome client retries remain release/activation gates.

Tests: actual Socket.IO owners plus pending DB boundary regression; actual
server/PostgreSQL HTTP fixture requires omitted-header denial and unchanged
file/message inventory after strict authentication, while a separate ordinary
member still uploads and downloads the exact bytes. Header-only requests prove
the strict denial does not wait for a body. No production/staging mutation.
