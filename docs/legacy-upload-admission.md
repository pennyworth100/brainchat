# Transitional HTTP upload admission (3.0.11 draft)

`server.ts` now looks up the exact server-owned physical socket and owner, then
uses the shared logical membership and durable session gate **after** rate
charging and **before** Multer or filesystem allocation. Revoked/expired/stale
generation or room-policy identities fail closed. The old `onlineUsers` map and
Socket.IO room joins no longer authorize anything and have been removed.

One unresolved authorization per socket and at most 100 per server are allowed.
A result arriving after 10 seconds cannot admit a parser; a hung DB operation
retains its capacity until it actually settles. No cancellation is implied.

This is an admission migration, not the completed resumable-upload pipeline:

- `x-socket-id` remains the existing HTTP bearer capability. Knowledge of it is
  sufficient; this change does not claim independent HTTP caller authentication.
- Once admitted, legacy Multer/persistence behavior is unchanged. Disconnect
  alone does not invalidate an already admitted upload. Later revocation during
  parsing is **not yet** rechecked at INSERT by this transitional route.
- Unknown persistence outcomes retain bytes and never automatically retry.
  Post-save notification failure does not invalidate persistence.
- Durable upload grants, credential-authenticated preflight, resource ledger,
  deadline/body framing and receipt-based persistence still need route wiring.
  Public resume and credentials remain unexposed until this is coherent.

`qa-public-session.ts` runs the real server against owned PostgreSQL and proves
revocation/generation/expiry/policy/wrong-room denial creates no token directory,
normal upload identity, single pending admission, and disconnect while the real
session lock blocks authorization. Existing full upload tests cover parser
limits, admitted-before-disconnect persistence and legacy response semantics.
