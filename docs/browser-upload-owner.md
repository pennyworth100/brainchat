# Browser upload owner — 3.0.30

An upload now captures its logical room owner before synchronization. Explicit
rejoin (even to the same room), terminal failure and disposal revoke that owner.
Transport-only recovery retains it. Every upload await boundary rechecks it,
including before a classified legacy 401 retry and after response-body parsing.
Late success cannot return a receipt to a replacement owner; stale 401 cannot
reconnect or upload as a newly joined username. The UI independently checks its
owner after awaiting the uploader, suppresses stale publication/error/resync,
and removes only that operation’s spinner.

Regression evidence uses the actual uploader, room controller and Socket.IO
server/client with explicitly controlled HTTP responses. Baseline 3.0.29 fails
twelve header/body completion cases; transport-only success/retry remain supported. Additional controller
tests cover room binding, successful-sync revocation and terminal failure.
The local real-fetch attempt was blocked by the runtime egress proxy even for
loopback; it is not counted as product regression evidence. Normal hosted CI
covers real HTTP and public PostgreSQL composition without changing proxy/TLS.

This is NOT durable upload ownership or receipt reconciliation. It cannot undo
an already submitted server write. Public resume credentials remain disabled;
no automatic replay of ambiguous outcomes or credential-mode changes is added.
Browser/device acceptance, coordinated credentials and pending text/upload
operations, physical byte/inode authority, capacity, exact-image and fresh
paired recovery gates remain. No live service or listener was changed.
