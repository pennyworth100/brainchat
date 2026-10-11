# Public upload activation gate — draft 3.0.11

Audited runtime source: a622bac9b4c0d53863447f15731064e0fd75656f.
Baseline main: 99d5f0bd3fae431bd5f0eb08ac49bc604685932b.
This change adds only evidence/tests, not runtime activation or physical authority.

## Exact current routing

- server.ts installs strict framing rejection before express.json. Either
  x-resume-session-id OR x-resume-token selects this path, including empty values.
- Valid room/socket/current owner and PostgreSQL rate admission are still needed.
  The strict branch verifies durable bearer, session, room, owner, generation,
  policy and expiry. Valid credentials return 503 UPLOAD_RESOURCE_UNAVAILABLE
  before parser/storage/reservation. Denial releases the unused upload grant.
- Partial, empty, malformed, combined and wrong-owner credentials must never
  reach legacy Multer. Raw duplicate custom headers normalize to combined values
  in Node; the canonical token/UUID validation rejects such values. The fixture
  tests combined values, not a new raw-proxy/HTTP-smuggling acceptance claim.
- Neither header selects LegacyUploadAdmission, then existing Multer storage.
  Socket-id remains a bearer capability. Removing BOTH headers therefore permits
  the legacy write for an otherwise authorized socket; strict denial is NOT a
  global upload block or a physical-resource boundary for the service.
- uploadRoomFile sends only room/socket headers. Repository plugin/runtime search
  found no producer of resume upload headers. Current browser compatibility
  depends on this legacy branch.
- Normal authenticated joins now create durable sessions and use private owners.
  publishJoin exposes history/presence only. Public resume is NOT registered;
  no session/token envelope is published. This supersedes the historical
  writer-coverage statement that server.ts imports no resume modules.

## Evidence added in this change

The actual-server / Socket.IO / owned-PostgreSQL fixture now adds seven empty or
combined credential cases, all requiring 403; verifies no file directory changes
or message/resource-ledger creation through strict denials; then omits both
headers and requires a legacy 200 with an independently queried file message and
downloaded exact bytes, while strict upload_resource_attempts stays empty.
Existing fixture coverage retains wrong/partial bearer, wrong owner, pre-body
framing rejection, repeated valid-bearer 503, revocation/generation/expiry, paused
multipart lifetime and lock/disconnect cases. This is isolated test evidence,
not a live user upload or physical accounting proof.

## Activation requirements (not optional deployment toggles)

1. Install separately reviewed physical byte AND inode authority, canonical
   resource-domain transaction, bounded parser/storage and durable receipt.
   Accounting COMMIT alone cannot authorize body/FS access.
2. Bind the exact admission/operation/attempt/root identity at storage entry;
   unknown/copied/expired authority must cause zero body/filesystem creation.
   Retain admission through settlement, including unknown COMMIT.
3. Replace the credentialless path with a SERVER-OWNED mode/policy. Header
   omission alone must not downgrade a credential-enabled session or namespace.
   An environment flag that merely turns on issuance is insufficient.
4. Migrate browser/plugin request producers and retry semantics with explicit
   legacy compatibility scope. Current 401 retry behavior cannot be applied to
   a request whose persistence outcome may be unknown.
5. Only then publish credentials/register resume, with end-to-end tests covering
   neither/either/both headers, omission after issuance, copied/wrong owner,
   revocation, expiry, disconnect, physical bounds and exact durable receipt.
6. Separately establish cross-store operational fencing for the actual rollout/
   backup. Per-socket admission is not an all-writer drain. Include old/new app
   processes, agent sends, room creation/claim, deferred touchRoom, rate-limit
   expiry timers, migrations/operator SQL, parser writes and late cleanup.
   Recovery-isolated maintenance evidence does not attest production fencing.

## Audit result

PASS: disabled strict route and legacy compatibility boundary are explicit and
regression-covered. HOLD: public credential activation, all-writer/RPO claims and
production release readiness. This HOLD is technical, not missing Max approval.
The existing authorization remains valid; no live settings or data changed.
Do not repeat completed provider/recovery tests as a substitute for the missing
physical contract or for actual production writer coverage.
