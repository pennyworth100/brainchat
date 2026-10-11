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

/** policy/pin must come from reviewed, trusted provisioning. The arithmetic
 * quote is NOT evidence that allAllocationCostsBounded is true in production.
 * Stable, server-controlled ancestors and no hostile same-uid mutation remain
 * prerequisites: portable Node path APIs do not provide openat confinement.
 */
export function bindStrictUploadRoot(
  pin: StrictUploadResourcePolicyPin, policy: unknown, expected: StrictUploadRootIdentity,
): StrictUploadRootBinding | null {
  const checked = recheckStrictUploadResourcePolicy(pin, policy);
  if (!checked || !expected || typeof expected.path !== "string" ||
      !isAbsolute(expected.path) || resolve(expected.path) !== expected.path ||
      expected.path.includes("\0") || expected.path !== checked.quote.identity.namespace ||
      !decimal(expected.device) || !decimal(expected.inode) || expected.inode === "0" ||
      !id(expected.uid) || !id(expected.gid) ||
      process.geteuid?.() !== expected.uid || process.getegid?.() !== expected.gid) return null;
  const root = Object.freeze({ path: expected.path, device: expected.device,
    inode: expected.inode, uid: expected.uid, gid: expected.gid });
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
  const bound = bindings.get(binding);
  if (!bound || bound.pin !== pin || bound.limit !== limit ||
      process.geteuid?.() !== bound.root.uid || process.getegid?.() !== bound.root.gid) {
    throw Error("Strict upload root denied");
  }
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
