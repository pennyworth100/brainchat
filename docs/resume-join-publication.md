# Private join publication (3.0.11 draft)

Not connected to server.ts; no rollout or public resume acceptance.

Compose resumeJoinPublication with the same memberships registry as the owner's
publishJoin option. The history callback takes a server binding and must perform
current DB authorization, returning null on denial and inert server-owned rows on
success. Credentials are never passed to this callback or emitted by this helper.
Transport checks do not replace DB authorization or snapshot/delta reconciliation.

The authenticated join's single promise includes publication: exact retries share
one history read and one sequence of handoffs. The existing overall deadline and
issuance capacity cover the history wait as well. Timeout, close, expiry or
replacement fence a delayed result; it cannot be redirected to a successor.
Exceptions and partial delivery permanently fail the physical owner's join,
without automatic replay. Packets already handed off cannot be recalled; success
is not a client ACK or an exactly-once network-delivery claim.

History goes only to the exact current joining socket. The join notice excludes
that exact sender; user-list (username compatibility projection) and user-count
use current membership and guarded fanout. Checks occur after the asynchronous
read and between handoffs, including reentrant owner close. Presence remains a
point-in-time view: it is not an atomic history/presence snapshot or an automatic
notification when other sessions expire. A future public migration must wire all
ordinary and resumed users, protected sends/DMs and policy checks coherently.
