# Rendered browser acceptance — 3.0.32 candidate

`QA_BASE_URL=http://127.0.0.1:3302 node scripts/qa-rendered-browser.mjs`
requires the built application running against an isolated database/upload root.
Install the pinned dev dependency with `npm ci` and its browser with
`npx playwright install --with-deps chromium`. No production URL/default exists.

The test drives the actual React entry/composer/file input with two Chromium
contexts, one at mobile viewport size. It checks room creation/password claim,
text receipts/draft clearing, offline write controls, missed-history recovery,
retained unsent draft, text after reconnect, actual file/image multipart,
peer rendering, exact download bytes, image decode/lightbox and timeline
deduplication. Outgoing real WebSocket frames attest a rejoin and keyed sends.
No controller, Socket.IO, HTTP response or database mock supplies the outcome.

This is legacy browser acceptance, NOT coordinated credential/generation-CAS
resume, unknown-receipt replay, physical iPhone/Safari or byte/inode authority.
Public resume stays disabled. The next migration must retain this acceptance
and add credential negotiation, generation CAS and pending text/image/file
receipt reconciliation before claiming full browser resume readiness.

CI runs this gate on the same production build used by HTTP/Socket.IO tests.
Any failed assertion/browser exception exits nonzero and blocks integration.
