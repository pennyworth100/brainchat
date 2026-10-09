# Private resumed-session resynchronization (3.0.10 draft)

Not wired to server.ts. No public resume, deployment, or client acceptance claim.

Use resumeResyncPublication as attachResumeSocket's publishResume option, with
the same ResumeMemberships registry. Membership installation and publication
run within ResumeAdmission's original single flight, capacity reservation and
deadline (CAS + preparation + installation + authorized history read).
Exact retries share one CAS/read/handoff sequence; conflicting requests do not
cancel the legitimate flight. Authenticated join uses publishJoin only.

The history callback must perform current DB policy authorization and return
inert server-owned rows, or null to deny. It receives a binding, never a token.
The helper sends history to the exact current transport, then guarded username
list/count to current room members. It emits NO joined system notice.
A replacement cannot receive its predecessor's delayed history or result.

Close/disconnect/expiry/replacement/timeout fence late results. Timeout retains
the admission capacity until the actual work settles. Denial and exceptions
permanently close/disconnect the owner without replay; slow cleanup cannot delay
the synchronous fence. The trusted finalizer must not await owner.close() from
inside its own flight (close awaits that flight); use synchronous/void fencing.
Partial handoffs cannot be recalled and are never automatically replayed.
A successful cached result is not fresh delivery authority.

Remaining before public wiring: atomic history/delta reconciliation, coherent
ordinary join/resume membership migration, protected sends/uploads/integration
fanout/DM policy, client sessionStorage and full contract/physical QA.
Presence snapshots are not atomic with history. Local loopback regression PASS
does not prove real PostgreSQL policy integration or production acceptance.
