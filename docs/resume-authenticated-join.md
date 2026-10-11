# Private authenticated-join composition (3.0.11 draft)

Normal authenticated join is now wired into server.ts, sharing one ResumeStore,
ResumeBindings and ResumeMemberships registry. This is an integration slice,
not public resume acceptance or release readiness. No token or resume handler is
exposed. Agent/file/disconnect broadcasts now use exact session memberships;
disconnect presence is recomputed from live leases, not the compatibility map.
Existing upload admission/persistence still uses a temporary legacy
projection and MUST migrate before resume is enabled. Outbound membership
fencing is local authority, not a fresh per-recipient database policy check.

Call owner.join only AFTER server-side password/creation authentication, with the
room, normalized username and authVersion observed by that authentication. The
issue option must be a bound ResumeStore.issueAfterAuthenticatedJoin function (or
a server closure); never take these inputs or the issue function from a client.
A memberships registry sharing the owner's bindings is required.

The physical owner reserves join versus resume synchronously. Exact join retries
share one promise, credential, CAS and membership. Conflicts return null without
closing the winner. Invalid requests do not reserve. Returned credentials are
frozen and must only go to this exact physical owner after current authorization.
A fulfilled promise is not permission to emit later: recheck exact membership at
the actual outbound boundary. No credential logging.

Issuance is separately bounded to 100 unresolved operations per process, with
the same configured timeout covering issuance plus admission. Timeout/disconnect
fences late issuance before CAS and never automatically retries an ambiguous
INSERT. Capacity remains held until real work settles, not merely until timeout.
An unreachable issued credential may remain in the database until absolute expiry;
no guessed rollback/revocation or replay. Owner close fences issuance immediately
but does not wait for the INSERT to settle. Admission cleanup retains its existing
awaitable semantics. The callable issue closure is trusted server code.

Optional publishJoin now composes a guarded, one-shot history/presence sequence
inside this same promise and deadline; see [join publication](resume-join-publication.md).
Without this option no history/presence is emitted. The public normal-join handler
authenticates first, then calls owner.join with the observed room authVersion.
Its publication reads history through ResumeHistoryReader/ResumeOperationGate,
rechecks exact membership and emits compatibility history/snapshot/presence.
Exact join retries share issuance/admission/publication; room-info may be resent.
Public sync now uses syncResumeSocket and the same transaction-authorized reader;
probeOnly remains local liveness, not DB policy validation.

The real-server regression scripts/qa-public-session.ts runs against an owned
loopback PostgreSQL cluster via scripts/qa-public-session-fixture.py. It covers
issuance, exact join retry, password rejection, no credential serialization,
legacy compatibility, policy-change history/text/image denial, text/image retry
receipts and conflicts, shared send exclusion, and disconnect during actual
blocked history SELECT and message INSERT. This does not prove atomic snapshot/
delta reconciliation, resumed transports, resource-ledger coverage or physical
mobile acceptance. Next: eliminate the legacy protected-path projection, then
wire resume and the browser protocol. Do not deploy this partial draft.
