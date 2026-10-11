# Private request-stream accounting (3.0.11 draft)

This helper is not installed on an HTTP route. It must run only after strict
raw-header framing, bearer admission and eventual disk-byte reservation.
It does not parse multipart, validate a file, publish a message or release leases.

- Snapshot canonical declared length; count actual envelope bytes, including
  multipart overhead. Reject early EOF, overrun, empty/non-byte chunks and chunks
  larger than 64 KiB before copying or forwarding the offending chunk.
- The 100 MiB + 64 KiB total cap comes from framing. The default maximum total
  lifetime is 30 seconds on a monotonic clock, including sink backpressure and
  iterator finalization. No per-chunk deadline renewal.
- Forward one copied chunk at a time, awaiting the sink before the next read.
  These bounds do not constrain allocations made upstream by the transport.
- Optional fifth argument `finish(signal)` runs once only after exact EOF and
  successful writes, before the request operation settles. Use it to call the
  maintained parser's `end()`, validate its final state and await final bounded
  sink work. It shares the original absolute deadline (no renewed timer).
  Rejection aborts the source; an uncooperative finalizer keeps the operation
  pending until actual settlement. This is a hook, not a multipart implementation.
- File-end or parser `onDone` is NOT permission to finalize a storage capability,
  dispatch a DB write, publish or release a lease. A real HTTP counterexample
  shows both callbacks before Content-Length EOF, then disconnect, deadline,
  delayed excess part or sink failure. Commit belongs after the whole operation,
  parser validation and storage durability, never inside `finish`.
- On failure/deadline signal cancellation and call the trusted transport abort
  hook once. Await actual next/write settlement, iterator return, and abort hook
  settlement. A source/sink/finalizer ignoring cancellation keeps the operation
  pending: timeout is NOT cancellation or permission to release disk/upload leases.
- Failure of abort/finalizer cannot become success. A failed cleanup hook provides
  no proof of resource closure; higher-level recovery must retain uncertain leases.
  A successful result proves byte accounting only, not persistence or authorization.

Future composition needs an audited maintained multipart parser with field/file
limits, a real IncomingMessage abort/closure adapter, checkContinue/checkExpectation
handling, server header/time limits, parser/file settlement and disk reconciliation.
After the 3.0.10 security re-baseline, the lockfile pins multer 2.4.0 and busboy
1.6.0. The public parser denies all text fields before append-field; upgrading
multer alone did not prevent the reproduced sparse-field CPU denial of service.
This does not approve either library for private resume composition: verify
header/resource bounds, backpressure and parser/file settlement against these
contracts first. Do not handroll a multipart parser.
