/** Private arithmetic only. Trusted in-process policy assertions are NOT evidence,
 * a capacity check, a reservation, or permission to perform any filesystem IO.
 * No public route imports this module. Not a hostile Proxy/object sandbox.
 */
export type UploadResourceIdentity = Readonly<{
  database: string;
  schema: string;
  namespace: string;
  quotaDomain: string;
  policyVersion: string;
  writerGeneration: string;
}>;

export type UploadResourceQuote = Readonly<{
  kind: "upload-resource-quote-only";
  identity: UploadResourceIdentity;
  maxFileBytes: number;
  logicalFileBytes: number;
  allocatedBytes: number;
  objects: number;
}>;

type RecordValue = Record<string, unknown>;
const identityKeys = ["database", "schema", "namespace", "quotaDomain", "policyVersion", "writerGeneration"] as const;
const maximum = BigInt(Number.MAX_SAFE_INTEGER);

// Accept plain data only; reading known own data descriptors never invokes getters.
function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as RecordValue : null;
}

function field(value: RecordValue, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function identity(value: unknown): UploadResourceIdentity | null {
  const input = record(value);
  if (!input) return null;
  const result: Record<string, string> = {};
  for (const key of identityKeys) {
    const text = field(input, key);
    if (typeof text !== "string" || !text.length || text.length > 512 ||
        text.trim() !== text || /[\u0000-\u001f\u007f]/.test(text)) return null;
    result[key] = text;
  }
  // Opaque canonical identities supplied by the trusted caller; no path normalization.
  return Object.freeze(result) as UploadResourceIdentity;
}

function integer(value: unknown, minimum = 0): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum &&
    !Object.is(value, -0) ? BigInt(value) : null;
}

/** Null means deny even a quote. A result never authorizes IO or refunds liability.
 * Required policy shape and assumptions are documented in upload-resource-cost.md.
 * No defaults: explicit zero overhead is an audited assertion, not an estimate.
 */
export function quoteUploadResources(policy: unknown, expectedIdentity: unknown): UploadResourceQuote | null {
  const input = record(policy), expected = identity(expectedIdentity);
  if (!input || !expected) return null;
  const boundIdentity = identity(field(input, "identity"));
  if (!boundIdentity || identityKeys.some(key => boundIdentity[key] !== expected[key])) return null;
  if (field(input, "layout") !== "provisioned-root-one-directory-one-file-v1" ||
      field(input, "allocationModel") !== "audited-rounded-copies-v1" ||
      field(input, "stableExclusiveNamespace") !== true ||
      field(input, "allAllocationCostsBounded") !== true) return null;

  const limit = integer(field(input, "maxFileBytes"));
  const unit = integer(field(input, "allocationUnitBytes"), 1);
  const copies = integer(field(input, "allocationCopies"), 1);
  const directory = integer(field(input, "directoryAndParentBytes"));
  const metadata = integer(field(input, "metadataBytes"));
  const temporary = integer(field(input, "temporaryBytes"));
  const extraObjects = integer(field(input, "additionalObjects"));
  if (limit === null || unit === null || copies === null || directory === null ||
      metadata === null || temporary === null || extraObjects === null) return null;

  // BigInt avoids rounding intermediate sums/products near MAX_SAFE_INTEGER.
  const logical = limit + 1n;
  const file = ((logical + unit - 1n) / unit) * unit * copies;
  const allocated = file + directory + metadata + temporary;
  const objects = 2n + extraObjects;
  if (logical > maximum || allocated > maximum || objects > maximum) return null;
  return Object.freeze({ kind: "upload-resource-quote-only", identity: boundIdentity,
    maxFileBytes: Number(limit), logicalFileBytes: Number(logical),
    allocatedBytes: Number(allocated), objects: Number(objects) });
}
