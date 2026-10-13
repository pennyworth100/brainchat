# Server-owned upload ledger lifetime (3.0.27)

`main({ strictUploads: { ledger, provision } })` is a **trusted in-process**
composition seam, not a public API or environment activation flag. The ordinary
CLI passes no configuration: strict upload/download remain disabled.

The server constructs exactly one strict ledger provider from the existing
verified-TLS configuration contract. Its provisioning callback receives that
provider and must return the paired writer/reader provisioning, or null. The
callback cannot replace the constructed provider. Policy/root/physical checks
remain in the existing paired service. Accounting is not physical authority.

The composed owner fences upload admission and ledger checkout synchronously,
retains both settlement promises, and waits for all outcomes. The ledger retains
raw connection acquisition and acquired leases before ending its own pool.
Construction failure also waits for owned ledger settlement. A failed close is
memoized and cannot become a later success. The server lifecycle owns this
composition; CLI shutdown explicitly rechecks its retained close promise before
closing the application pool and reporting successful shutdown.

## Evidence

- Unit regressions: absent configuration, acquired-lease retention, failed
  provisioning retention, persistent close failure and invalid config refusal.
- `python3 scripts/qa-upload-ledger-tls-fixture.py --server` starts the actual
  server and an isolated TLS PostgreSQL instance. A minimally privileged ledger
  role retains a real acquired lease from the provisioning callback. HTTP is
  ready; drain rejects new room creation with 503 and stays pending. Releasing
  the lease allows settlement; ledger-role backend count becomes zero.
- This fixture returns null physical provisioning. It proves actual-server
  provider ownership and TLS settlement, **not** a provider-enabled upload,
  physical byte/inode enforcement, a full deployment image audit, or production
  recovery. Ordinary public compatibility and CLI SIGTERM proofs also run.

## Remaining release gates

Trusted production physical provisioning, sustainable capacity, coordinated
browser credentials/reconnect/receipt handling, browser/device acceptance,
fresh paired backup at the old-writer fence and exact-image rollout/rollback
checks remain required. Max's existing authorization is not missing.
