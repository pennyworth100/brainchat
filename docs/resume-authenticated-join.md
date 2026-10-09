# Private authenticated-join composition (3.0.10 draft)

Not wired into server.ts. This is not public resume acceptance or rollout approval.

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
Without this option no history/presence is emitted. Public auth handlers are still
unchanged. Next: migrate normal join and resumed connections to a single
authoritative projection, then all protected outbound/send/DM handlers, before
enabling the feature.
