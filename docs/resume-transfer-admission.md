# Private provenance-transfer admission (3.0.33 draft)

`ResumeAdmission.transfer` and the server-object-owned `owner.transfer` admit an
explicit transfer through the **same** physical-attempt reservation, capacity
permit, monotonic deadline, preparation, cleanup, binding registry and membership
finalizer as ordinary CAS. They do not mutate the database before admission.
Normal authenticated join and transfer remain mutually exclusive on one owner.

Input retains the original expected generation and original operation ID,
separately from the distinct transfer operation ID. The store atomically checks
original provenance and advances to originalExpected + 2. Admission validates
that exact generation; it never fabricates a normal-CAS expected generation.
Invalid/missing transfer IDs or unavailable transfer support cannot downgrade
to ordinary CAS. Exact calls on one live owner share the same promise; changed
IDs, normal CAS, or a second transfer cannot replace its reserved attempt.

A database success alone is not membership. After awaited persistence and
preparation, exact server ownership/liveness must still permit activation and
the original membership finalizer. Timeout or disconnect fences immediately,
retains the permit until actual settlement, and denies late activation.
Unknown/superseded provenance or a lost transfer database acknowledgment stays
terminal for this incarnation. The store still rejects replay on another owner:
there is only one retained receipt, not a chain authenticating the original
operation forever.

## Evidence and limits

Five admission regressions cover provenance snapshots, exact +2 validation,
malformed/unavailable transfer, no fallback/replay, retained capacity, deadline,
disconnect and exact cleanup. Existing CAS lifecycle tests remain unchanged.

The isolated PostgreSQL suite adds 65 checks with actual loopback Socket.IO
owners: successful successor membership/old-owner fencing; competitor and
unknown denials; withheld database acknowledgment; observed row-lock waits with
disconnect/timeout; retained capacity and no late membership. The overall suite
has 524 checks, including a 98-check preflight block that contains these 65 and
the prior 33 checks, plus the existing 42 browser-core checks. Counts are nested,
not additive. Local full suite: 907 application + 5 plugin tests PASS;
build/typecheck PASS; production dependency audit zero.

This is a PRIVATE server seam. No public event, browser transfer ticket,
credential publication, rendered resume UI or readiness claim is added.
The browser still needs original-CAS provenance preservation across disconnect,
an explicit owner/physical-attempt-fenced transfer state, and a separate +2
acceptance path. Lost transfer ACK must remain uncertain; it cannot authorize
another blind CAS or an endless provenance chain. Full synchronization and
persisted file-byte identity remain independent gates.
