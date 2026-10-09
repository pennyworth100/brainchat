# Private request-stream accounting (3.0.10 draft)

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
The inspected lockfile pins multer 1.4.5-lts.2 and busboy 1.6.0. Do not assume
this legacy multer is suitable: audit maintenance/security and parser lifecycle
before composition. Do not handroll a multipart parser.
