# Upload retry contract — 3.0.13

The browser retries once only for HTTP 401 with `code: UPLOAD_AUTH_REQUIRED`.
The server emits this marker only before parser/admission/body storage begins.
A status code alone, malformed JSON, a generic proxy rejection or a different
code is not permission to replay an attachment. Older servers without the
marker lose automatic retry, but uploads and explicit room reconnection remain.

`UPLOAD_OUTCOME_UNKNOWN` dominates all HTTP statuses, including 401 and 2xx.
It never reconnects or resubmits automatically. Network loss/timeouts likewise
retain the check-history instruction. This marker is an API contract under the
existing trusted HTTP/TLS boundary, not a signed or durable storage receipt.

The isolated actual-server PostgreSQL fixture proves an explicit rejection,
one reconnect, two HTTP requests and exactly one file directory/message. Unit
regressions cover ambiguous/malformed/null 401, unknown outcomes at five status
codes, one-retry bound and non-401 marker rejection. No public resume credential
issuance, strict storage activation, physical authority or production change.
