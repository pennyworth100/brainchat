# Bounded multipart prerequisite — 3.0.16

Private, unregistered parser for the missing public upload composition. It does
not activate the route: strict authenticated uploads still return 503 before body
consumption. Call only AFTER authentic accounting and physical authorization.
This module is not an authority provider or an implementation of the HTTP route.

Consumes exactly one file part using bounded request chunks, Content-Length,
deadline and awaited transport closure from consumeResumeRequest. Part headers
are at most 8192 bytes. There must be exactly one Content-Disposition for file
with a quoted filename and one Content-Type. Metadata uses the same canonical
file validation as storage. UTF-8 is decoded strictly. Other fields, duplicate or
extended headers, escaped filenames, additional parts and epilogues are rejected.
A closing delimiter accepts either no final CRLF or exactly one CRLF. A boundary
marker inside file content with an invalid suffix is deliberately rejected, not
treated as file content. This is a narrow grammar, not a general MIME parser.

Callbacks are serial and awaited. File size is checked before sink writes. Only
exact request EOF AND valid final syntax allow finish, under the body deadline.
Neither file-end nor finish authorizes a DB write/publication; the owner must
await this entire operation. Failure awaits transport settlement and sink abort.
The sink must retain admission and all physical/accounting liabilities through
actual settlement; abort is cleanup, never permission to refund or unlink.

Still missing: exact-grant accounting/physical authorization before parser start,
a storage session that accepts metadata after authorization, durable-file receipt
to ResumeFileUpload, HTTP registration, and physical provider evidence. Existing
StrictFileStorage.stage currently accepts metadata BEFORE reserving resources;
it cannot safely be called from parser.start without a separate authorized
session. Do not solve that ordering gap by reading headers before authority.
