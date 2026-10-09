# Private outbound fencing (3.0.11 draft)

`ResumeMemberships.send` checks the exact binding object, requested room, current
generation, absolute expiry, connected socket and installed membership immediately
before handing a packet to Socket.IO. Call it **after** every asynchronous read or
authorization step. A stale history/snapshot result is dropped, never redirected
to the current session successor. Copied bindings and unsupported event names fail
closed. Admission without installed membership grants no outbound access.

`broadcast` snapshots candidate bindings, then rechecks each recipient separately.
A successor pending preparation already fences its predecessor even while that old
socket is physically connected. Closing another recipient during a synchronous
outgoing callback prevents its later delivery. New members are not added to an
in-progress candidate snapshot. No Socket.IO room membership is consulted.

Only inert, server-built payloads and trusted synchronous Socket.IO hooks are
supported: no getters, toJSON callbacks or application work inside serialization.
The linearization boundary is the call to emit: a packet already handed to
Socket.IO cannot be recalled by later close/replacement, including a hook inside
that same emit. True means handed off, not received or acknowledged. Errors throw;
do not blindly replay a partial broadcast. This is process-local, not a
transactional DB policy check or a distributed fanout protocol.

Still PRIVATE and unused by server.ts. Migrate ordinary joins, history, presence,
all message/image/file/integration broadcasts and both DM paths coherently before
enabling resume. Existing public room broadcasts remain unfenced by this seam.
Presence semantics, rate limits, UI, complete acceptance and physical QA remain
open. Loopback tests use stubbed persistence, not PostgreSQL.
