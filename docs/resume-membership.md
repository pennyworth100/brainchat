# Private exact membership leases (3.0.10 draft)

`ResumeMemberships` is a server-owned logical membership registry, not room
authorization. Share one registry with the process's `ResumeBindings`. Install
only with the actual socket, its `attachResumeSocket` owner and the successful
binding returned by admission. These are trusted server objects, not request data.
Never install in admission preparation, which must not grant outbound access.

A successor first owns the exact session slot, then releases its predecessor's
lease and physically disconnects the old Socket.IO connection. The old
disconnect/disposer cannot delete or detach the successor. Duplicate installation
returns the same lease. Stale bindings, transport mismatch and closed sockets
are rejected. Cleanup is idempotent; reentrant disconnect callbacks are followed
by a current-authority check. Eviction failure fences the new binding and throws;
it does not restore old authority or claim the old transport was disconnected.

No public handler imports this registry. It does not join rooms, mutate the old
`onlineUsers` map, emit presence or deliver history. There is consequently no
duplicate presence emission from this seam, but public presence migration is NOT
complete. DB authorization and coherent outbound fencing still precede enabling
resume. Expiry makes `isCurrent` false; it does not schedule physical eviction.
This is process-local; multi-process eviction is not implemented. `disconnect(true)`
closes the physical connection (all namespaces), consistent with one owner per
transport. Do not share that transport with independently owned namespaces.

The registry independently caps retained memberships at 10,000 (configurable).
Expired yet connected leases count until released or disconnected; overload
rejects installation without evicting unrelated members. Admission success alone
does not imply membership success: composition must close a rejected owner.

Explicit owner close synchronously releases the exact membership and registry
capacity even while asynchronous preparation cleanup is pending or fails. It
does not physically disconnect that socket. Close subscriptions reject closed
owners and are removed by lease release; late old-owner cleanup cannot release
a successor. Admission-plus-install composition remains a separate next step.
