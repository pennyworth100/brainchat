/** Private read-only root binding, NOT physical capacity or upload authority.
 * No runtime consumer. Trusted provisioner supplies expected identity; never
 * learn dev/inode from the path and silently authorize whatever is there.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { recheckStrictUploadResourcePolicy, type StrictUploadResourcePolicyPin } from "./upload-resource-policy-pin";

export type StrictUploadRootBinding = Readonly<{ kind: "strict-upload-root-binding-only" }>;
export type StrictUploadRootIdentity = Readonly<{
  path: string; device: string; inode: string; uid: number; gid: number;
}>;
type Bound = Readonly<{
  root: StrictUploadRootIdentity; pin: StrictUploadResourcePolicyPin; limit: number;
}>;
const bindings = new WeakMap<StrictUploadRootBinding, Bound>();
const decimal = (s: unknown) => typeof s === "string" && /^(0|[1-9][0-9]{0,19})$/.test(s);
const id = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffffff;

// Snapshot own data properties before validation. Repeated accessor reads could
// validate one namespace/identity and then capture another. As with policy pins,
// this is a trusted provisioning boundary, not a hostile-JavaScript sandbox.
function snapshotRoot(value: unknown): StrictUploadRootIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const data: Record<string, unknown> = {};
  for (const key of ["path", "device", "inode", "uid", "gid"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    data[key] = descriptor.value;
  }
  if (typeof data.path !== "string" || !isAbsolute(data.path) ||
      resolve(data.path) !== data.path || data.path.includes("\0") ||
      !decimal(data.device) || !decimal(data.inode) || data.inode === "0" ||
      !id(data.uid) || !id(data.gid)) return null;
  return Object.freeze(data) as StrictUploadRootIdentity;
}

/** policy/pin must come from reviewed, trusted provisioning. The arithmetic
 * quote is NOT evidence that allAllocationCostsBounded is true in production.
 * Stable, server-controlled ancestors and no hostile same-uid mutation remain
 * prerequisites: portable Node path APIs do not provide openat confinement.
 */
export function bindStrictUploadRoot(
  pin: StrictUploadResourcePolicyPin, policy: unknown, expected: StrictUploadRootIdentity,
): StrictUploadRootBinding | null {
  const checked = recheckStrictUploadResourcePolicy(pin, policy);
  const root = snapshotRoot(expected);
  if (!checked || !root || root.path !== checked.quote.identity.namespace ||
      process.geteuid?.() !== root.uid || process.getegid?.() !== root.gid) return null;
  const binding = Object.freeze({ kind: "strict-upload-root-binding-only" as const });
  bindings.set(binding, Object.freeze({ root, pin, limit: checked.quote.logicalFileBytes }));
  return binding;
}

/** READ ONLY. Exact pin binds all immutable domain/adapter/cost/limit inputs.
 * Copied binding, wrong pin/limit or changed effective identity causes zero IO.
 * Path replacement/symlink/mode/owner mismatch causes no mutation or body read.
 * Caller owns close only after successful return; failed checks close here.
 * Returning a directory handle never authorizes mkdir/write or consumes a grant.
 */
export async function openStrictUploadRoot(
  binding: StrictUploadRootBinding, pin: StrictUploadResourcePolicyPin, limit: number,
): Promise<FileHandle> {
  if (!matchesStrictUploadRoot(binding, pin, limit)) {
    throw Error("Strict upload root denied");
  }
  const bound = bindings.get(binding)!;
  const handle = await open(bound.root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isDirectory() || st.dev.toString() !== bound.root.device ||
        st.ino.toString() !== bound.root.inode || st.uid !== BigInt(bound.root.uid) ||
        st.gid !== BigInt(bound.root.gid) || (st.mode & 0o7777n) !== 0o700n ||
        process.geteuid?.() !== bound.root.uid || process.getegid?.() !== bound.root.gid) {
      throw Error("Strict upload root denied");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** In-memory identity check ONLY; no path observation or physical authority. */
export function strictUploadRootPath(
  binding: StrictUploadRootBinding, pin: StrictUploadResourcePolicyPin, limit: number,
): string | null {
  return matchesStrictUploadRoot(binding, pin, limit) ? bindings.get(binding)!.root.path : null;
}

/** In-memory identity check ONLY; no path observation or physical authority. */
export function matchesStrictUploadRoot(
  binding: StrictUploadRootBinding, pin: StrictUploadResourcePolicyPin, limit: number,
): boolean {
  const bound = bindings.get(binding);
  return !!bound && bound.pin === pin && bound.limit === limit &&
    process.geteuid?.() === bound.root.uid && process.getegid?.() === bound.root.gid;
}
