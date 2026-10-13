import type { Pool } from "pg";
import type { ResumeUploadAdmissions } from "./resume-upload-admission";
import { createStrictUploadService, type StrictUploadProvisioning } from "./strict-upload-service";
import { createStrictUploadLedgerProvider, type UploadLedgerConfiguration } from "./upload-ledger-provider";

type Provider = ReturnType<typeof createStrictUploadLedgerProvider>;
/** Trusted in-process composition only. Never derive this from a request or an
 * activation flag. A null provision keeps both upload and download disabled. */
export type OwnedStrictUploadConfiguration = Readonly<{
  ledger: UploadLedgerConfiguration;
  provision: (provider: Provider) => Omit<StrictUploadProvisioning, "provider"> | null |
    Promise<Omit<StrictUploadProvisioning, "provider"> | null>;
}>;

export async function createOwnedStrictUploadService(pool: Pool, admissions: ResumeUploadAdmissions,
  configuration: OwnedStrictUploadConfiguration | null) {
  const provider = configuration ? createStrictUploadLedgerProvider(configuration.ledger) : null;
  try {
    const provisioning = provider ? await configuration!.provision(provider) : null;
    const service = createStrictUploadService(pool, admissions,
      provisioning && provider ? { ...provisioning, provider } : null);
    let closing: Promise<void> | undefined;
    return Object.freeze({ ...service,
      close(): Promise<void> {
        if (closing) return closing;
        // Fence BOTH owners synchronously, then retain all SQL, parser and I/O
        // settlement even if one owner rejects. Never force-release a lease.
        const uploads = service.uploads.close();
        const ledger = provider?.close() ?? Promise.resolve();
        closing = Promise.allSettled([uploads, ledger]).then(results => {
          const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Strict upload settlement unconfirmed");
        });
        return closing;
      },
    });
  } catch (error) {
    // Construction owns any raw connects/leases started by trusted provisioning.
    // Do not return its failure while that ownership is still outstanding.
    try { await provider?.close(); }
    catch (closing) { throw new AggregateError([error, closing], "Strict upload startup settlement unconfirmed"); }
    throw error;
  }
}
