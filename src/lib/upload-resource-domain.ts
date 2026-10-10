/** Private locked-row evaluation only; no query, mutation or storage authority.
 * Caller must hold the canonical domain lock and supply exactly one current row.
 * See docs/upload-resource-domain.md. Not a hostile-JavaScript sandbox.
 */
import { recheckUploadResourcePolicy } from "./upload-resource-policy-pin";
import type { UploadResourceQuote } from "./upload-resource-quote";

export type UploadResourceDomainEvaluation = Readonly<{
  kind: "upload-resource-domain-evaluation-only";
  quote: UploadResourceQuote;
  auditId: string;
  outstandingBytesAfter: string;
  outstandingObjectsAfter: string;
}>;

function row(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
// PostgreSQL bigint must be selected as text: never trust global pg type parsers.
// Bound length BEFORE BigInt, reject coercion, alternate encodings and overflow.
function exact(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length > 16 || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null;
}

/** expectedAuditId comes from trusted provisioning, not from the row/request.
 * Matching audit text is NOT verification of an audit, physical fence or volume.
 * All writers/provisioners must use the same domain lock; this pure function
 * cannot prove a lock, row count, DB provenance, freshness or policy immutability.
 */
export function evaluateUploadResourceDomain(
  pin: unknown, lockedPolicy: unknown, lockedDomain: unknown, expectedAuditId: unknown,
): UploadResourceDomainEvaluation | null {
  if (!text(expectedAuditId)) return null;
  const policy = recheckUploadResourcePolicy(pin, lockedPolicy);
  const domain = row(lockedDomain);
  if (!policy || !domain || field(domain, "active") !== true ||
      field(domain, "audit_id") !== expectedAuditId) return null;
  const identity = policy.quote.identity;
  for (const [column, expected] of [
    ["database_identity", identity.database], ["schema_identity", identity.schema],
    ["quota_domain", identity.quotaDomain], ["writer_generation", identity.writerGeneration],
  ] as const) {
    if (field(domain, column) !== expected) return null;
  }
  const after: string[] = [];
  for (const [dimension, cost] of [
    ["bytes", BigInt(policy.quote.allocatedBytes)], ["objects", BigInt(policy.quote.objects)],
  ] as const) {
    const capacity = exact(field(domain, "capacity_" + dimension));
    const headroom = exact(field(domain, "headroom_" + dimension));
    const baseline = exact(field(domain, "baseline_" + dimension));
    const outstanding = exact(field(domain, "outstanding_" + dimension));
    if (capacity === null || capacity === 0n || headroom === null ||
        baseline === null || outstanding === null) return null;
    // One shared, monotonic envelope across namespaces AND generations.
    // BigInt preserves an over-capacity sum instead of rounding/wrapping it.
    if (cost > capacity - headroom - baseline - outstanding) return null;
    after.push((outstanding + cost).toString());
  }
  return Object.freeze({ kind: "upload-resource-domain-evaluation-only", quote: policy.quote,
    auditId: expectedAuditId, outstandingBytesAfter: after[0], outstandingObjectsAfter: after[1] });
}
