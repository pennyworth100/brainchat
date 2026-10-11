/** Private trusted-policy snapshot/recheck only. NOT a connection authority,
 * admission grant, reservation, physical fence or hostile-JavaScript sandbox.
 * No application route imports this module. See upload-resource-policy-pin.md.
 */
import { quoteUploadResources, quoteStrictUploadResources, type UploadResourceQuote } from "./upload-resource-quote";

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
export type StrictUploadResourcePolicyPin = Readonly<{ kind: "strict-upload-resource-policy-pin-only" }>;
export type PinnedStrictUploadResourcePolicy = Readonly<{
  adapter: "resume-strict-writer-v1";
  policy: Readonly<Data>;
  quote: UploadResourceQuote;
}>;
const strictPins = new WeakMap<StrictUploadResourcePolicyPin, PinnedStrictUploadResourcePolicy>();
type Adapter = PinnedUploadResourcePolicy["adapter"] | PinnedStrictUploadResourcePolicy["adapter"];

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

function snapshot<A extends Adapter>(policy: unknown, expected: unknown, adapter: A):
  Readonly<{ adapter: A; policy: Readonly<Data>; quote: UploadResourceQuote }> | null {
  const data = own(policy, [...policyKeys, "identity", "adapter"]);
  if (!data || data.adapter !== adapter) return null;
  const identity = own(data.identity, identityKeys);
  if (!identity) return null;
  data.identity = Object.freeze(identity);
  const quote = adapter === "resume-strict-writer-v1"
    ? quoteStrictUploadResources(data, expected) : quoteUploadResources(data, expected);
  if (!quote) return null;
  // All retained values are validated primitives or our own frozen identity.
  return Object.freeze({ adapter, policy: Object.freeze(data), quote });
}

/** Trusted server policy only, synchronously before checkout/await. No supplied
 * charge is accepted. The pin is process-local and conveys no IO authority.
 */
export function pinUploadResourcePolicy(policy: unknown, expectedIdentity: unknown): UploadResourcePolicyPin | null {
  const captured = snapshot(policy, expectedIdentity, "multer-crossing-byte-v1");
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
  const current = snapshot(lockedPolicy, before.quote.identity, "multer-crossing-byte-v1");
  if (!current || policyKeys.some(key => current.policy[key] !== before.policy[key])) return null;
  // Equality is on every policy input, not merely equal aggregate charges.
  return current;
}

/** Separate registry prevents a strict writer pin from entering the existing
 * Multer transaction path (or vice versa), even when rounded costs coincide.
 * Same trusted-policy and canonical-domain lock requirements as above apply.
 */
export function pinStrictUploadResourcePolicy(policy: unknown, expectedIdentity: unknown): StrictUploadResourcePolicyPin | null {
  const captured = snapshot(policy, expectedIdentity, "resume-strict-writer-v1");
  if (!captured) return null;
  const pin = Object.freeze({ kind: "strict-upload-resource-policy-pin-only" as const });
  strictPins.set(pin, captured);
  return pin;
}

export function recheckStrictUploadResourcePolicy(pin: unknown, lockedPolicy: unknown): PinnedStrictUploadResourcePolicy | null {
  if (!pin || typeof pin !== "object") return null;
  const before = strictPins.get(pin as StrictUploadResourcePolicyPin);
  if (!before) return null;
  const current = snapshot(lockedPolicy, before.quote.identity, "resume-strict-writer-v1");
  if (!current || policyKeys.some(key => current.policy[key] !== before.policy[key])) return null;
  return current;
}
