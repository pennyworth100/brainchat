# Initialized-process SIGTERM settlement — 3.0.14

The executable server installs one SIGTERM handler after successful startup.
It synchronously closes lifecycle admission, waits for the existing tracked
HTTP/socket/parser/storage/owner/expiry/activity producers, then closes Socket.IO
and HTTP, Next, and the application PostgreSQL pool. Only after all these
operations resolve does it log `Dimle shutdown settled`; natural process exit
is used, not `process.exit(0)`. A rejected shutdown logs unconfirmed settlement
and sets a nonzero exit code. A stuck shutdown remains pending.

Repeated SIGTERM signals cannot invoke a second drain, bypass a pending producer,
retry a write, or force a successful exit. The signal hook is CLI-only; importing
main for owned fixtures does not install global process listeners.

The source Railway start command now invokes Node directly instead of adding an
npm parent. Effective deployment configuration and native signal delivery still
must be verified at rollout; the prior isolated native candidate used npm start
and is not evidence for this new command or hook.

The owned --shutdown fixture starts the real CLI process with an isolated
PostgreSQL cluster, blocks an actual agent INSERT, sends SIGTERM twice, verifies
new room admission returns 503 and the child has not exited, releases SQL, then
requires one persisted message, one shutdown, exit 0 and zero child DB backends.
Existing multi-producer lifecycle tests cover multipart/storage settlement.

## Limits and rollout requirements

This is an initialized single-process application drain, not a global recovery
or physical-storage fence. SIGTERM during startup remains the platform's default
termination path; no startup-success or migration-rollback claim is made.
No SIGINT/SIGKILL interception, deadline, filesystem flush, upload refund,
credential activation, external-writer fence or provider grace setting is added.
The platform can still force termination before settlement; absence of the
settled result must remain unknown. Historical handler failures in the returned
report do not prove rollback, even when no producer remains.

Old production 3.0.3 lacks this hook. A fresh paired backup still needs its own
verified platform/process/DB fence; this patch cannot make that old image drain.
Readiness is separately configured/verified at rollout (issue 16); the existing
landing page is not a continuous drain/readiness endpoint.

Physical byte/inode authority, strict storage composition and public resume
integration remain release gates. Max's existing production authorization is
valid; this change neither deploys nor claims those technical gates passed.
