import type { Pool } from "pg";
import { StrictUploadAccounting } from "./strict-upload-accounting";
import { StrictFileStorage, type StrictStoragePhysicalAuthority } from "./strict-file-storage";
import { StrictUploadRuntime } from "./strict-upload-runtime";
import { ResumeFileWriter } from "./resume-file";
import { ResumeFilePublication } from "./resume-file-publication";
import { ResumeUploadOperationGate } from "./resume-operation";
import type { ResumeUploadAdmissions } from "./resume-upload-admission";
import type { StrictDownloadSource } from "./upload-download";
import { recheckStrictUploadResourcePolicy } from "./upload-resource-policy-pin";

type AccountingArgs = ConstructorParameters<typeof StrictUploadAccounting>;
export type StrictUploadProvisioning = Readonly<{
  provider: AccountingArgs[1]; pin: AccountingArgs[2]; policy: AccountingArgs[3];
  root: AccountingArgs[4]; provenance: AccountingArgs[5];
  physical: StrictStoragePhysicalAuthority;
}>;

/** Server-only paired composition. One DB/schema, root, policy and limit for
 * writer AND reader. This is not a provisioner or physical authority. Production
 * must pass null until a real byte+inode provider and all release gates pass.
 * The pool and accounting provider remain owned by the caller's lifecycle.
 */
export function createStrictUploadService(pool: Pool, admissions: ResumeUploadAdmissions,
  provisioning: StrictUploadProvisioning | null) {
  const writer = new ResumeFileWriter(new ResumeUploadOperationGate(pool, admissions));
  if (!provisioning) return Object.freeze({
    uploads: new StrictUploadRuntime(admissions, null, writer),
    downloads: null as StrictDownloadSource | null,
  });
  const { provider, pin, policy, root, provenance, physical } = provisioning;
  const checked = recheckStrictUploadResourcePolicy(pin, policy);
  if (!checked || !physical) throw Error("Strict upload provisioning denied");
  const accounting = new StrictUploadAccounting(admissions, provider, pin, policy, root, provenance);
  const storage = new StrictFileStorage(admissions, accounting, physical);
  const publication = new ResumeFilePublication(pool);
  const downloads: StrictDownloadSource = Object.freeze({
    root, pin, limit: checked.quote.logicalFileBytes,
    publishedFile: publication.publishedFile.bind(publication),
  });
  return Object.freeze({ uploads: new StrictUploadRuntime(admissions, storage, writer), downloads });
}
