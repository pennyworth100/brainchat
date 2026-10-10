/** Private trusted SQL composition only. No reservation or filesystem authority.
 * No runtime consumer. See docs/upload-ledger-transaction.md.
 */
import { randomUUID } from "node:crypto";
import type { createUploadLedgerProvider } from "./upload-ledger-provider";
import type { UploadResourcePolicyPin } from "./upload-resource-policy-pin";
import type { UploadLedgerLease } from "./upload-ledger-lease";

type Provider = ReturnType<typeof createUploadLedgerProvider>;
type Query = UploadLedgerLease["query"];
export type UploadLedgerTransactionOutcome = Readonly<{
  kind: "upload-ledger-transaction-only";
  status: "not-committed" | "committed" | "unknown";
  attemptId: string;
  commitDispatched: boolean;
}>;
type Work = (context: Readonly<{
  attemptId: string; pin: UploadResourcePolicyPin;
  binding: Provider["binding"]; query: Query;
}>) => Promise<"prepared" | "denied">;

/** work is reviewed server code, NOT caller-supplied SQL. It must lock/recheck,
 * charge and INSERT this exact attemptId atomically, with no transaction-control
 * SQL, outside effects or retained query use. This helper cannot prove that SQL
 * contract. Even committed is accounting-only, not a reservation/storage grant.
 */
export async function runUploadLedgerTransaction(
  provider: Provider, pin: UploadResourcePolicyPin, work: Work,
): Promise<UploadLedgerTransactionOutcome> {
  const attemptId = randomUUID(); // retained on every outcome; never regenerated on failure
  let commitDispatched = false;
  const outcome = (status: UploadLedgerTransactionOutcome["status"]) =>
    Object.freeze({ kind: "upload-ledger-transaction-only" as const, status, attemptId, commitDispatched });
  let checked: Awaited<ReturnType<Provider["checkout"]>>;
  try { checked = await provider.checkout(pin); }
  catch { return outcome("not-committed"); }
  if (checked.status !== "acquired") return outcome("not-committed");
  const { lease, binding } = checked;
  const finish = (status: UploadLedgerTransactionOutcome["status"], broken: boolean) => {
    const finalized = lease.finalize(broken);
    return outcome(finalized === (broken ? "destroyed" : "released") ? status : "unknown");
  };
  try {
    const begin = await lease.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (begin.command !== "BEGIN") return finish("not-committed", true);
  } catch { return finish("not-committed", true); }

  let accepting = true, queryFailed = false;
  const pending = new Set<Promise<unknown>>();
  const query: Query = (sql, values) => {
    if (!accepting) return Promise.reject(Error("Upload ledger transaction scope closed"));
    const result = lease.query(sql, values);
    // Observe even a forgotten/rejected promise: it must not turn into COMMIT.
    const observed = result.then(() => undefined, () => { queryFailed = true; });
    pending.add(observed);
    void observed.then(() => pending.delete(observed));
    return result;
  };
  let prepared = false;
  try {
    prepared = await work(Object.freeze({ attemptId, pin: checked.pin, binding, query })) === "prepared";
  } catch { /* rollback below; never expose driver errors/credentials */ }
  accepting = false;
  // Unawaited work is a contract violation. Drain before rollback/finalization,
  // never release a connection with an outstanding query or race it with COMMIT.
  if (pending.size) prepared = false;
  await Promise.all(pending);
  if (!prepared || queryFailed) {
    try {
      const rollback = await lease.query("ROLLBACK");
      return finish(rollback.command === "ROLLBACK" ? "not-committed" : "unknown", rollback.command !== "ROLLBACK");
    } catch { return finish("unknown", true); }
  }
  commitDispatched = true; // BEFORE invoking driver, including synchronous throw
  try {
    const commit = await lease.query("COMMIT");
    // PostgreSQL can answer COMMIT with command=ROLLBACK for an aborted tx.
    if (commit.command !== "COMMIT") return finish("unknown", true);
  } catch {
    // Do not issue ROLLBACK/retry after a dispatched COMMIT. Its ACK can be lost
    // while both charges and durable attempt exist. Retain the identity.
    return finish("unknown", true);
  }
  return finish("committed", false);
}
