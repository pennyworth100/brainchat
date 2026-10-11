# Private strict upload accounting bridge

`StrictUploadAccounting` composes the existing strict provider, canonical-domain
SQL and transaction with an exact opaque upload admission and root binding.
This is **accounting only**, not the physical reservation/storage bridge.
There is no route, body source, root open, directory creation or storage consumer.
Do not adapt its receipt to the legacy `ResumeFileStorage.reserve` interface.

Construction snapshots the pinned policy and server-owned audit/writer IDs.
Reservation validates the admission ceiling against the strict quote and exact
in-memory root binding before checkout. An exact grant is attempted at most once
across coordinator instances. Each attempt receives a server-generated operation
UUID; SQL persists that UUID alongside the transaction-generated attempt UUID.
Neither identity comes from request-controlled SQL, policy or storage paths.

Only an acknowledged COMMIT and a still-current grant/root binding produce an
opaque accounting receipt. Resolution requires the same coordinator, exact grant
and exact receipt; copies and expiry fail. The frozen record binds root, pin,
limit, operation UUID, attempt UUID and bounded client-message ID. It is NOT a
durable message receipt or evidence of a physical filesystem reservation.

Unknown COMMIT keeps its exact outcome/attempt ID and never retries or sends a
post-COMMIT ROLLBACK. Expiry before preparation settles rolls back; expiry while
COMMIT is pending does not race/cancel it. A later committed outcome stays charged
but yields no receipt. The bridge never releases admission; only the owner may
finalize after all actual stream/file/DB work settles. No refunds or file cleanup.

Outstanding: distinct reviewed physical authority, physical byte AND inode costs
or supported isolated quota, root revalidation at actual storage entry, and the
complete parser/storage/operation-receipt integration. The in-memory root match
does not inspect the path or replace `openStrictUploadRoot`'s inode checks.
All arithmetic tests use synthetic policy; no live policy is enabled or seeded.
