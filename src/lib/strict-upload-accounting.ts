/** PRIVATE accounting bridge. No HTTP, body, filesystem or physical authority.
 * Even a committed receipt MUST NOT be passed to ResumeFileStorage as reserve.
 */
import { randomUUID } from "node:crypto";
import { ResumeUploadAdmissions, type ResumeUploadGrant } from "./resume-upload-admission";
import { recheckStrictUploadResourcePolicy, type StrictUploadResourcePolicyPin } from "./upload-resource-policy-pin";
import { matchesStrictUploadRoot, type StrictUploadRootBinding } from "./upload-storage-root";
import { createStrictUploadResourceSqlWork } from "./upload-resource-sql";
import { runStrictUploadLedgerTransaction, type UploadLedgerTransactionOutcome } from "./upload-ledger-transaction";

type Provider = Parameters<typeof runStrictUploadLedgerTransaction>[0];
export type StrictUploadAccountingReceipt = Readonly<{ kind: "strict-upload-accounting-only" }>;
type RecordData = Readonly<{
  grant: ResumeUploadGrant; root: StrictUploadRootBinding; pin: StrictUploadResourcePolicyPin;
  operationId: string; attemptId: string; clientMessageId: string; limit: number;
}>;
// A second coordinator must not retry the same exact grant after any outcome.
const attempted = new WeakSet<ResumeUploadGrant>();

export class StrictUploadAccounting {
  private readonly policy;
  private readonly receipts = new WeakMap<StrictUploadAccountingReceipt, RecordData>();
  private readonly auditId: string;
  private readonly writerId: string;

  constructor(private readonly admissions: ResumeUploadAdmissions,
    private readonly provider: Provider, private readonly pin: StrictUploadResourcePolicyPin,
    policy: unknown, private readonly root: StrictUploadRootBinding,
    provenance: Readonly<{ auditId: string; writerId: string }>) {
    const captured = recheckStrictUploadResourcePolicy(pin, policy);
    const { auditId, writerId } = provenance;
    if (!captured || !matchesStrictUploadRoot(root, pin, captured.quote.logicalFileBytes) ||
        !createStrictUploadResourceSqlWork(pin, captured.policy, { auditId, writerId, operationId: "validation-only" })) {
      throw Error("Strict upload accounting configuration denied");
    }
    this.policy = captured;
    this.auditId = auditId; this.writerId = writerId;
  }

  // Server-authenticated grant only. Client ID is bounded data, never SQL/policy.
  // No retries, refunds, cancellation races or admission release on any path.
  async reserve(grant: ResumeUploadGrant, clientMessageId: string): Promise<Readonly<
    { status: "denied" } | { status: "settled"; outcome: UploadLedgerTransactionOutcome;
      receipt: StrictUploadAccountingReceipt | null }
  >> {
    const limit = this.admissions.byteLimit(grant);
    if (limit === null || attempted.has(grant) || limit !== this.policy.quote.logicalFileBytes ||
        !matchesStrictUploadRoot(this.root, this.pin, limit) ||
        typeof clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)) {
      return Object.freeze({ status: "denied" as const });
    }
    attempted.add(grant); // before checkout/await, shared across coordinators
    const operationId = randomUUID();
    const work = createStrictUploadResourceSqlWork(this.pin, this.policy.policy,
      { auditId: this.auditId, writerId: this.writerId, operationId })!;
    const outcome = await runStrictUploadLedgerTransaction(this.provider, this.pin, async context => {
      if (!this.admissions.isCurrent(grant)) return "denied";
      const result = await work(context);
      return this.admissions.isCurrent(grant) ? result : "denied";
    });
    let receipt: StrictUploadAccountingReceipt | null = null;
    if (outcome.status === "committed" && this.admissions.isCurrent(grant) &&
        matchesStrictUploadRoot(this.root, this.pin, limit)) {
      receipt = Object.freeze({ kind: "strict-upload-accounting-only" });
      this.receipts.set(receipt, Object.freeze({ grant, root: this.root, pin: this.pin,
        operationId, attemptId: outcome.attemptId, clientMessageId, limit }));
    }
    return Object.freeze({ status: "settled" as const, outcome, receipt });
  }

  /** Returns accounting provenance, NEVER permission to open/mkdir/write. */
  resolve(grant: ResumeUploadGrant, receipt: StrictUploadAccountingReceipt): RecordData | null {
    const record = this.receipts.get(receipt);
    return record?.grant === grant && this.admissions.isCurrent(grant) &&
      matchesStrictUploadRoot(record.root, record.pin, record.limit) ? record : null;
  }
}
