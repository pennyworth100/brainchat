# Private physical-socket owner (3.0.11 draft)

`attachResumeSocket` is deliberately NOT called by `server.ts`. It creates no
public event, token, room membership, history, presence, broadcast or DB schema change.
The optional private [lifecycle composition](resume-lifecycle.md) installs logical
membership and physically evicts replaced sockets; it is not public room access.

One process/module WeakMap reserves each actual Socket.IO server Socket object.
Same-options reattachment returns the same frozen owner, even after close.
A competing options object throws before installation. Dependencies are captured
on first attach; never use a per-request options object or duplicate module copies.
The incarnation is a server random UUID, not `socket.id` or handshake data.

`disconnecting` permanently fences admission synchronously, before normal
Socket.IO room cleanup. `close()` is idempotent and preserves its completion or
failure. Late CAS cannot activate; late preparation releases its exact lease.
Automatic disconnect cleanup reports errors once; explicit close still rejects.
Preparation must clean its own partial failure and must not expose any data.

Owners now share a pending-work budget and admission deadline; see
[admission limits](resume-admission-limits.md). They do NOT cancel DB work or gate
outbound broadcasts. Without lifecycle composition they do not evict a
superseded socket. `close()` can wait indefinitely
for work even after an admission timeout. A superseded
socket remains physically connected until separately closed, although its binding
is fenced. Never put these sockets in public room broadcast membership yet.

Observed current server seams: `join-room` installs onlineUsers/socket membership
before loading history, then broadcasts presence. HTTP upload/integration and
send-message/send-image use `io.to(roomId)`; sync and DM also use socket/onlineUsers
membership. Its disconnect handler deletes only by socket.id. These paths need a
coherent admission/outbound-authority design before enabling resume. This private
adapter is not evidence that any of those existing paths is protected.

Five real loopback Socket.IO tests cover ownership/no public handler, client
disconnect during CAS, server disconnect during preparation, stale disconnect
versus successor, and cleanup error reporting/closed reattachment. DB is stubbed
in these lifecycle tests; existing PostgreSQL integration tests remain separate.
