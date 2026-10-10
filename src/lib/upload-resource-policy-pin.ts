/** Private trusted-policy snapshot/recheck only. NOT a connection authority,
 * admission grant, reservation, physical fence or hostile-JavaScript sandbox.
 * No application route imports this module. See upload-resource-policy-pin.md.
 */
import { quoteUploadResources, type UploadResourceQuote } from "./upload-resource-quote";

const identityKeys = ["database", "schema", "namespace", "quotaDomain", "policyVersion", "writerGeneration"] as const;
const policyKeys = ["layout", "allocationModel", "stableExclusiveNamespace", "allAllocationCostsBounded",
  "maxFileBytes", "allocationUnitBytes", "allocationCopies", "directoryAndParentBytes",
  "metadataBytes", "temporaryBytes", "additionalObjects"] as const;
type Data = Record<string, unknown>;
export type UploadResourcePolicyPin = Readonly<{ kind: "upload-resource-policy-pin-only" }>;
export type PinnedUploadResourcePolicy = Readonly<{
  adapter: "multer-crossing-byte-v1";
  policy: Readonly<Data>;
  quote: UploadResourceQuote;
}>;
const pins = new WeakMap<UploadResourcePolicyPin, PinnedUploadResourcePolicy>();

function own(value: unknown, keys: readonly string[]): Data | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result: Data = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function snapshot(policy: unknown, expected: unknown): PinnedUploadResourcePolicy | null {
  const data = own(policy, [...policyKeys, "identity", "adapter"]);
  if (!data || data.adapter !== "multer-crossing-byte-v1") return null;
  const identity = own(data.identity, identityKeys);
  if (!identity) return null;
  data.identity = Object.freeze(identity);
  const quote = quoteUploadResources(data, expected);
  if (!quote) return null;
  // All retained values are validated primitives or our own frozen identity.
  return Object.freeze({ adapter: "multer-crossing-byte-v1", policy: Object.freeze(data), quote });
}

/** Trusted server policy only, synchronously before checkout/await. No supplied
 * charge is accepted. The pin is process-local and conveys no IO authority.
 */
export function pinUploadResourcePolicy(policy: unknown, expectedIdentity: unknown): UploadResourcePolicyPin | null {
  const captured = snapshot(policy, expectedIdentity);
  if (!captured) return null;
  const pin = Object.freeze({ kind: "upload-resource-policy-pin-only" as const });
  pins.set(pin, captured);
  return pin;
}

/** Caller must already hold the canonical domain row lock on the trusted pinned
 * client. Read current policy under that lock, then call this before any UPDATE.
 * A matching result is arithmetic evidence only, never proof the lock was held.
 */
export function recheckUploadResourcePolicy(pin: unknown, lockedPolicy: unknown): PinnedUploadResourcePolicy | null {
  if (!pin || typeof pin !== "object") return null;
  const before = pins.get(pin as UploadResourcePolicyPin);
  if (!before) return null;
  const current = snapshot(lockedPolicy, before.quote.identity);
  if (!current || policyKeys.some(key => current.policy[key] !== before.policy[key])) return null;
  // Equality is on every policy input, not merely equal aggregate charges.
  return current;
}
