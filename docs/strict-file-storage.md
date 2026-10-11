# Private strict storage bridge — candidate 3.0.15

StrictFileStorage composes authentic strict accounting with the pinned root and
a SEPARATE trusted physical-authority provider. There is NO production provider,
runtime registration, configuration toggle, public credential issuance or parser
activation. The public strict upload route remains 503 before body consumption.

A missing provider denies before accounting, body access or filesystem access.
An unknown accounting COMMIT cannot invoke physical authorization or storage.
After acknowledged accounting, a frozen request binds the exact opaque grant,
root, pin, limit, clientMessageId, operationId and attemptId. Physical authority
must cover that exact request and return its own opaque receipt. The sink never
casts accounting receipts into the old byte-reservation adapter.

Physical authorization is a trusted provisioning interface, NOT an implemented
quota mechanism or an attestation of Railway capacity. Tests use explicitly
synthetic receipts in disposable directories; they prove composition, not
allocation bounds. A provider must retain all byte/inode liabilities regardless
of disconnect, timeout, expiry, failure, successful storage, or unknown database
outcome. There is deliberately no release/refund method. Reconciliation and an
audited physical implementation remain required before any activation.

Root device/inode/owner/mode are checked on the opened root before mkdir. Stable,
server-controlled ancestors and no hostile same-uid mutation remain prerequisites
(portable Node path calls are not openat confinement). The path is the pinned
namespace, never a constructor-supplied independent root string. Each grant can
attempt this sink once across coordinators. Metadata is snapshotted before await.

The storage key is SHA256(JSON.stringify(["strict-upload-storage-v1",
operationId, attemptId])). That deterministic mapping is reconciliation data,
not authority. Exclusive directory/blob creation never overwrites an old path.
No cleanup/unlink occurs on failure; liabilities remain. File, directory and root
sync/close all complete before an opaque staged receipt is issued. Copied receipt,
wrong grant, expired admission or revoked physical write authority cannot resolve.

ResumeFileUpload accepts the narrow stage/resolve interface so it can compose
this sink without changing existing file-message/unknown-COMMIT semantics.
Admission is not released by either layer. Public parser integration, a real
physical provider, physical byte AND inode evidence, crash reconciliation and
actual PostgreSQL/platform acceptance remain separate gates.

## Executable acceptance

Ten unit regressions exercise missing/forged authority, copied receipts, exact
identity, root replacement, uncertain accounting COMMIT, parallel coordinators,
metadata snapshot, oversized chunks and revocation during actual pending IO.
`qa-upload-ledger-tls-fixture.py --storage` uses an owned TLS PostgreSQL cluster
and real files/message receipts. It covers acknowledged accounting, missing
physical provider, lost accounting ACK, lost message ACK and pending message
COMMIT past admission expiry. Physical permits and cost inputs are SYNTHETIC.
Missing authority gives zero accounting/body/files; a lost accounting ACK retains
its durable row but gives zero body/files. A lost message ACK retains the file,
accounting and durable message receipt while reporting message COMMIT unknown.
The pending message case retains admission until actual settlement. Neither test
claims native Railway acceptance or physical-resource bounds.

`ResumeFileUpload`'s `commit` field describes the MESSAGE transaction only.
A storage/accounting failure before that transaction reports message
`not-dispatched`; this is NEVER evidence that accounting rolled back or that
resource liability may be refunded. There is no automatic retry or reclamation.
