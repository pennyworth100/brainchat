# Private HTTP request source (3.0.11 draft)

`resumeHttpSource` adapts an exclusively owned, already-admitted Node
IncomingMessage for `consumeResumeRequest`. Factory and iterator acquisition
do not read, flow, or attach transport listeners. Actual iteration/explicit abort
starts ownership. Single use only; previously read, decoded, flowing or destroyed
requests fail closed.

Native async iteration preserves backpressure; coalesced buffers are delivered
as <=64 KiB views, then the consumer copies each admitted chunk. This is NOT a
bound on Node/kernel allocation. Abort destroys the request and waits for its
actual close event; early iterator return and errors also await close. Normal
EOF additionally requires complete/readableEnded. Native iterator handles stream
errors; the adapter retains an error listener through close for pre-read abort.

Loopback raw TCP tests cover exact length, mid-body disconnect, stalled body,
sink rejection, sink deadline and real closure. No public route is installed.
Framing + bearer preflight + future durable disk reservation must precede reads.
This is not multipart parsing, quota/reconciliation, auth or release acceptance.
A future HTTP server still needs header limits/deadlines and checkContinue /
checkExpectation handlers; Node can otherwise emit 100 Continue before admission.
