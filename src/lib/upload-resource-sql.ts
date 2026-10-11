/** Private fixed-table accounting callback. No runtime consumer or storage grant. */
import { evaluateUploadResourceDomain } from "./upload-resource-domain";
import { recheckUploadResourcePolicy, type UploadResourcePolicyPin } from "./upload-resource-policy-pin";
import type { runUploadLedgerTransaction } from "./upload-ledger-transaction";

type Work = Parameters<typeof runUploadLedgerTransaction>[2];
type Provenance = Readonly<{ auditId: string; operationId: string; writerId: string }>;
const validText = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

/** Inputs are trusted provisioning/server operation data, never request-selected
 * policy, charges, SQL or table names. Capture synchronously before any await.
 * Return value is ONLY for runUploadLedgerTransaction; never call independently.
 * Schema is additive migration 0009, intentionally not installed/activated live.
 */
export function createUploadResourceSqlWork(
  pin: UploadResourcePolicyPin, policy: unknown, provenance: Provenance,
): Work | null {
  const captured = recheckUploadResourcePolicy(pin, policy);
  const { auditId, operationId, writerId } = provenance;
  if (!captured || ![auditId, operationId, writerId].every(validText)) return null;
  const identity = captured.quote.identity;
  let used = false;
  return async context => {
    // One operation callback cannot prepare a second attempt, even after denial.
    if (used) return "denied";
    used = true;
    if (context.pin !== pin || context.binding.database !== identity.database ||
        context.binding.schema !== identity.schema ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(context.attemptId)) return "denied";
    const key = [identity.database, identity.schema, identity.quotaDomain];
    // Namespace/generation NEVER partition the canonical liability lock.
    const domains = await context.query(`SELECT database_identity, schema_identity,
      quota_domain, writer_generation, active, audit_id,
      capacity_bytes::text, headroom_bytes::text, baseline_bytes::text, outstanding_bytes::text,
      capacity_objects::text, headroom_objects::text, baseline_objects::text, outstanding_objects::text
      FROM public.upload_resource_domains
      WHERE database_identity=$1 AND schema_identity=$2 AND quota_domain=$3 FOR UPDATE`, key);
    if (domains.rowCount !== 1 || domains.rows.length !== 1) return "denied";
    // Every provisioner MUST acquire the same domain lock before editing policy.
    // SHARE additionally prevents changes to this existing policy until COMMIT.
    const policies = await context.query(`SELECT policy_snapshot FROM public.upload_resource_policies
      WHERE database_identity=$1 AND schema_identity=$2 AND quota_domain=$3
      AND namespace=$4 AND policy_version=$5 AND writer_generation=$6 FOR SHARE`,
    [...key, identity.namespace, identity.policyVersion, identity.writerGeneration]);
    if (policies.rowCount !== 1 || policies.rows.length !== 1) return "denied";
    const evaluated = evaluateUploadResourceDomain(pin, policies.rows[0].policy_snapshot, domains.rows[0], auditId);
    if (!evaluated) return "denied";
    const updated = await context.query(`UPDATE public.upload_resource_domains
      SET outstanding_bytes=$4::bigint, outstanding_objects=$5::bigint
      WHERE database_identity=$1 AND schema_identity=$2 AND quota_domain=$3
      RETURNING outstanding_bytes::text, outstanding_objects::text`,
    [...key, evaluated.outstandingBytesAfter, evaluated.outstandingObjectsAfter]);
    if (updated.command !== "UPDATE" || updated.rowCount !== 1 || updated.rows.length !== 1 ||
        updated.rows[0].outstanding_bytes !== evaluated.outstandingBytesAfter ||
        updated.rows[0].outstanding_objects !== evaluated.outstandingObjectsAfter) return "denied";
    // No upsert/replay: duplicate UUID or operation is an error -> outer rollback.
    const inserted = await context.query(`INSERT INTO public.upload_resource_attempts
      (attempt_id, database_identity, schema_identity, quota_domain, namespace,
       policy_version, writer_generation, audit_id, operation_id, writer_id,
       allocated_bytes, objects, policy_snapshot)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::bigint,$12::bigint,$13::jsonb)
      RETURNING attempt_id::text`,
    [context.attemptId, ...key, identity.namespace, identity.policyVersion, identity.writerGeneration,
      auditId, operationId, writerId, String(evaluated.quote.allocatedBytes), String(evaluated.quote.objects),
      JSON.stringify(captured.policy)]);
    return inserted.command === "INSERT" && inserted.rowCount === 1 && inserted.rows.length === 1 &&
      inserted.rows[0].attempt_id === context.attemptId ? "prepared" : "denied";
  };
}
