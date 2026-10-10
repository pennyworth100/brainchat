# Public upload admission: resource cost contract

2026-10-09; draft 3.0.11, parent `31b09d60a25baf1d57dbd657f76c3a081d7f6886`.
Private quote arithmetic/tests/documentation only. This defines inputs required before admission wiring;
it neither supplies measured capacity nor enables a budget, cleanup or rollout.

## Source-derived bound and executed proof

[createUploadParser](../src/lib/upload-parser.ts) permits one file, zero text
fields and one part, with an inclusive 100 MiB file limit supplied by
[server.ts](https://github.com/pennyworth100/brainchat/blob/31b09d60a25baf1d57dbd657f76c3a081d7f6886/server.ts#L349).
Locked Multer 2.4.0 make-middleware.js:94–107 gives Busboy fileSize+1.
Busboy 1.6.0 multipart.js:467–480 clamps each emitted chunk to the remaining
file budget, pushes the crossing byte, then skips the rest of that part.
Its :340–346 files limit rejects another file before a second file event.
Thus the configured path has at most one disk handle invocation and can send
**L+1 logical file bytes** to storage, even though only <=L may be accepted.
This is conditional on this exact parser/storage path, not arbitrary engines,
other writers, physical allocation or the deployed 3.0.3 dependency tree.

[Executable regression](../src/lib/upload-resource-cost.test.ts) uses real
Express/loopback HTTP/createUploadParser/Multer disk/Busboy, and a destination
callback mirroring the public recursive mkdir in an owned temporary root.
It holds the completed disk callback only to read exact bytes before removal.
No filesystem monkeypatch, unlink substitution, live upload or DB is involved.

| Input file bytes (fixture limit L=6) | Bytes observed before cleanup | Parser result | Objects remaining before test teardown |
| --- | --- | --- | --- |
| 6 | 6 | Accepted | One directory and one six-byte file |
| 7 | 7 | LIMIT_FILE_SIZE | One empty directory |
| 1,048,576 | 7 | LIMIT_FILE_SIZE | One empty directory |

All cases invoke destination/handle/parser once; rejected cases invoke actual
disk removal and its callback once. This fixture maps errors to 400, not the
public server's 413 mapping. The large-body test is empirical evidence for this
input, not exhaustive chunk-split coverage; the general clamp is source-derived.
It does not bound request network bytes, HTTP drain duration, kernel buffers,
process memory, or prove storage durability. Multer drains rejected request
bodies; L+1 is not an HTTP body limit.

## Resource dimensions cannot be collapsed to payload length

The public destination creates a per-upload directory; disk removal unlinks
only the file and never removes that directory. Success, uncertain DB outcomes
and failed removal may retain the file as well. Even a zero-byte file or a
successful rejection cleanup must not be priced as zero resource use.

Under a provisioned, stable, owned root and exclusive creation contract, reserve
for **one directory plus one file inode**, as well as their allocated space.
That is a minimum two-object allowance, not a portable physical-inode proof.
Recursive root creation, another storage layout, filesystem metadata, snapshots,
CoW, shared consumers or additional temporary objects may require more.
Current public recursive mkdir and default write-stream open are **not exclusive
ownership enforcement**. Random directory names do not prove uniqueness or
stable ancestry; neither this test nor a path string closes that activation gate.

For L=104,857,600, the logical file upper bound is 104,857,601. If an independently
audited allocation model uses 4,096-byte units with no other data amplification,
the rounded file component alone is 104,861,696 bytes (25,601 units).
This is an illustration, **not** an observed Railway block size or complete
physical reservation. Directory/parent growth, metadata, journaling/CoW and
safety headroom remain outside that number. Never invent a fixed filesystem
overhead multiplier from payload length or a single stat call.

## Fail-closed quote/admission contract (admission not implemented)

Treat resource liability as a vector, not one interchangeable counter:

- Logical file ceiling: L+1, checked with exact nonnegative integer arithmetic.
- Allocated-byte upper bound: audited file-allocation upper-bound function at
  L+1, plus bounded directory/parent growth and all attributable metadata/temp
  overhead. Unknown allocation/amplification assumptions deny admission.
- Object/inode allowance: at least the directory and file under the stated
  layout, plus any independently established additional cost.
- Identity: DB/schema, canonical owned namespace/root, physical quota domain,
  storage-policy version and fenced writer generation. A quote for another
  identity/version must not authorize even mkdir.

A future implementation must reject missing/invalid/negative/nonfinite/unsafe
integer inputs, arithmetic overflow, unknown identity/ownership/layout, or
unproven capacity/headroom; do not coerce, round down, truncate or default to zero.
A client Content-Length, reported upload size or content type is not authority
to reserve less. Reserve the maximum before uploadMiddleware/first FS effect,
after authentication/limiter. A durable grant must bind the quote to one attempt
and actual enforced write limits; a pure computed quote is not an admission.

For each separately accounted physical resource, require atomically:

`audited existing liability + outstanding reservations + new quote + headroom <= enforced capacity`

All terms must share the same quota domain and disjoint accounting convention:
do not double-count settled allocations as both baseline and outstanding charge,
and never remove liability based merely on HTTP completion. Fence or independently
bound every other consumer/replica/old writer; statfs is a racy observation, not a
reservation. Bytes and inodes must both pass. A byte-only singleton DB budget
cannot substitute for a multi-resource shared-volume admission protocol.

Unknown outcomes remain charged. Successful file unlink alone is not full
settlement because the directory remains; missing reference/path, request abort,
timeout, restart or a scan supplies no refund authority. This contract adds no
automatic reclaim, replay, retries, ledger seeding or existing-file deletion.
Conservative overcharging can exhaust admission; stop/deny, never reset to zero.
A reconciliation/refund protocol requires separate provenance and stable paired
DB/filesystem evidence, and is deliberately not supplied here.

## Verification provenance and remaining work

Parent CI [push](https://github.com/pennyworth100/brainchat/actions/runs/38017873843)
and [PR](https://github.com/pennyworth100/brainchat/actions/runs/38017875910)
completed SUCCESS. New regression: three passing cases; whole-tree verification:
499 application + 5 plugin tests (504 total), typecheck, build and diff check PASS;
production dependency audit zero vulnerabilities (not a dev-tree clean claim).
Full logs are preserved as resource-cost-20261009-checks.json, SHA-256
fb2d7dcd386debb8602b563c1f026d232a3730b07d18b5984df180c20b2ef80e.
No production runtime/dependency/schema/version
change, public admission implementation or local PostgreSQL rerun is claimed.

Inspected installed dependency SHA-256:

| File | SHA-256 |
| --- | --- |
| multer/lib/make-middleware.js | 75d1113f73af6ba5a3632de12942273f10b939867800fb2955e26ad9ba6eabb9 |
| multer/storage/disk.js | 756e3ca6eefb2824a8a275b10137a3baa6d75c45d65909a6432d8850be089a28 |
| busboy/lib/types/multipart.js | ed88b51e44c230f124163a75ee87cba322584a2f0360eafc7b38727a33ec9268 |

## Private quote implementation (2026-10-09 follow-up)

[quoteUploadResources](../src/lib/upload-resource-quote.ts) now supplies only
side-effect-free arithmetic over **trusted in-process policy assertions**.
[Nine regressions](../src/lib/upload-resource-quote.test.ts) cover identity denial,
missing inputs/overhead, boundaries, overflow, accessors, and immutable snapshots.
It returns null on invalid input, or a frozen `upload-resource-quote-only` value.
It has no capacity inputs, ledger, IO, clock, authority token or public caller.
Repeated calls return quotes, not multiple reservations or admission grants.

Required policy fields (none have defaults):

| Field | Required meaning |
| --- | --- |
| `identity` | Exact nonempty opaque strings for database, schema, namespace, quotaDomain, policyVersion, writerGeneration; each must match a separately supplied expected identity |
| `layout` | `provisioned-root-one-directory-one-file-v1`; caller attests the root is already provisioned and this layout bounds this operation |
| `allocationModel` | `audited-rounded-copies-v1`; independently audited upper-bound model, not discovered filesystem geometry |
| `stableExclusiveNamespace`, `allAllocationCostsBounded` | Both exactly true; assertions of external evidence, not evidence produced by this function |
| `maxFileBytes` | Trusted configured parser maximum L, never client size/Content-Length |
| `allocationUnitBytes`, `allocationCopies` | Positive safe integers for audited rounding unit and upper-bound data allocation multiplier |
| `directoryAndParentBytes`, `metadataBytes`, `temporaryBytes` | Explicit nonnegative safe integer bounds, collectively covering all attributable non-file-data allocation; zero is an audited assertion, never a fallback |
| `additionalObjects` | Explicit nonnegative object/inode cost beyond one directory plus one file; include any temporary, metadata or additional-copy objects if applicable |

Calculation uses exact BigInt intermediates:
`logical=L+1`, `file=ceil(logical/unit)*unit*copies`,
`allocated=file+directoryAndParent+metadata+temporary`, `objects=2+additionalObjects`.
All numeric inputs and returned totals fit nonnegative JS safe integers; minus
zero, fractions, coercions and overflowing totals deny. L=0 still quotes one
crossing byte and at least two objects. Unknown model/layout denies. Opaque
identity equality does not canonicalize paths or verify mount/quota identity.
Plain data records are required; known accessor/inherited fields are rejected.
Hostile Proxies are outside this internal interface's trust boundary.

The example numbers in tests are synthetic, **not Railway capacity or overhead**.
This function does not prove the caller's assertions, enforce parser limits,
validate live capacity, establish writer fencing or perform atomic accounting.
Before any mkdir/write, a separate durable admission must validate current policy,
identity, full capacity/headroom vector and all-writer enforcement, then reserve
atomically and bind the operation to the grant. A quote alone can never activate
public upload. Unknown capacity/headroom must deny that admission even if quote
arithmetic succeeded. No seeding, refunds, scans, reclaim or public wiring added.

Follow-up verification: 508 application + 5 plugin tests (513 total), typecheck,
build and diff check PASS; production dependency audit zero vulnerabilities
(not a dev-tree audit claim). Full command logs: resource-quote-20261009-checks.json,
SHA-256 `6370453841459be65d93931fbc4b975a0d8eeeba920983a3c2231807b49fc8e9`.
Parent `026967b724498874321e6d9232a5847a136c3455` push/PR CI both SUCCESS.
No public server, schema, dependency or version change; no local PostgreSQL rerun.

Actual shared multi-resource reservation, storage enforcement, all-writer fencing
and paired recovery remain open in [the release gate](upload-observability-admission.md).
