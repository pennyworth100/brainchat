import type { BlobContentObservation } from "./resume-blob-content-observation";
import type { ReferenceObservation } from "./resume-reference-inventory";

type Comparison = "match" | "conflict" | "unobserved";
export type KeyedContentObservation = {
  // Caller-attested, stable namespace identity, NOT a path or room identifier.
  namespaceId: string;
  storageKey: string;
  content: BlobContentObservation;
};
export type ReferenceContentComparison = {
  size: Comparison;
  digest: Comparison;
  crossStoreStability: "unproven";
  fullIdentity: "unobserved";
};
const hex = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const namespace = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128 &&
  /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value);

// PRIVATE pure comparison of ONE explicitly paired reference/observation.
// Caller binds DB reference and actual observed root to the same trusted stable
// namespace identity. Matching caller labels cannot establish that binding.
// Never select a winner among duplicate references/observations; compare each
// pair independently and retain the inputs + source/scan completeness outside
// this value. No scan, aggregate PASS, absence, ownership or repair authority.
export function compareUploadReferenceContent(reference: ReferenceObservation,
  referenceNamespaceId: string | null, observed: KeyedContentObservation | null,
): ReferenceContentComparison {
  const result: ReferenceContentComparison = { size: "unobserved", digest: "unobserved",
    crossStoreStability: "unproven", fullIdentity: "unobserved" };
  if (!observed || !namespace(referenceNamespaceId) || !namespace(observed.namespaceId) ||
      referenceNamespaceId !== observed.namespaceId || !hex(reference.storageKey) ||
      !hex(observed.storageKey) || reference.storageKey !== observed.storageKey ||
      reference.status !== "reference" || reference.metadataStatus !== "valid") return result;
  const content = observed.content;
  // Defend against structurally inconsistent inputs; partial positive metadata
  // must never be promoted to a completed content comparison.
  if (content.complete !== true || content.stability !== "unchanged-at-checks" ||
      content.crossStoreStability !== "unproven" || content.reasons.length !== 0 ||
      !content.metadata || content.metadata.linkCount !== "1" || !hex(content.sha256) ||
      typeof content.metadata.sizeBytes !== "string" || content.metadata.sizeBytes.length > 8 ||
      !/^(0|[1-9][0-9]*)$/.test(content.metadata.sizeBytes) ||
      !Number.isSafeInteger(content.bytesRead) || content.bytesRead < 0 ||
      content.bytesRead > 64 * 1024 * 1024 ||
      content.metadata.sizeBytes !== String(content.bytesRead)) return result;
  // Size and digest declarations remain independent; malformed/missing one does
  // not invent a conflict or erase a valid comparison of the other.
  if (Number.isSafeInteger(reference.declaredSize) && reference.declaredSize! >= 0)
    result.size = BigInt(reference.declaredSize!) === BigInt(content.metadata.sizeBytes) ? "match" : "conflict";
  if (hex(reference.declaredSha256)) result.digest = reference.declaredSha256 === content.sha256 ? "match" : "conflict";
  return result;
}
