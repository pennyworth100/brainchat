import type { Socket } from "socket.io";
import type { BrowserLease } from "./browser-resume-controller";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeMemberships } from "./resume-membership";
import { ownsResumeSocket, requireStrictUpload, type ResumeSocketOwner } from "./resume-socket";
import type { ResumeCredential } from "./resume-store";

type Handoff = (lease: BrowserLease) => void;

// PRIVATE migration adapter. No public event registration or room authentication.
// join input MUST come from the existing server authentication, never client authVersion.
// The caller's synchronous handoff must target only this physical socket, not a room.
// true means handed off, NOT received, synchronized, persisted or safe to replay.
function publish(socket: Socket, owner: ResumeSocketOwner, members: ResumeMemberships,
  binding: ResumeBinding, credential: ResumeCredential, handoff: Handoff): boolean {
  if (!socket.connected || !ownsResumeSocket(socket, owner) ||
      members.currentBindingFor(socket, owner) !== binding ||
      credential.roomId !== binding.roomId || credential.sessionId !== binding.sessionId ||
      !requireStrictUpload(socket, owner, binding)) return false;
  // Credentials and the anti-downgrade transition belong to the same exact owner.
  // No authVersion, server incarnation or internal binding is serialized.
  handoff(Object.freeze({ roomId: binding.roomId, username: binding.username,
    sessionId: binding.sessionId, token: credential.token,
    generation: binding.generation, expiresAt: binding.expiresAt }));
  return true;
}

export async function publishBrowserJoin(socket: Socket, owner: ResumeSocketOwner,
  members: ResumeMemberships, authenticated: Parameters<ResumeSocketOwner["join"]>[0],
  handoff: Handoff): Promise<boolean> {
  if (!socket.connected || !ownsResumeSocket(socket, owner)) return false;
  const joined = await owner.join({ ...authenticated });
  return !!joined && publish(socket, owner, members, joined.binding, joined.credential, handoff);
}

export async function publishBrowserResume(socket: Socket, owner: ResumeSocketOwner,
  members: ResumeMemberships, request: Parameters<ResumeSocketOwner["admit"]>[0],
  handoff: Handoff): Promise<boolean> {
  if (!socket.connected || !ownsResumeSocket(socket, owner)) return false;
  const credential = Object.freeze({ ...request.credential });
  const binding = await owner.admit({ credential, expectedGeneration: request.expectedGeneration,
    operationId: request.operationId });
  return !!binding && publish(socket, owner, members, binding, credential, handoff);
}
export async function publishBrowserTransfer(socket: Socket, owner: ResumeSocketOwner,
  members: ResumeMemberships, request: Parameters<ResumeSocketOwner["transfer"]>[0],
  handoff: Handoff): Promise<boolean> {
  if (!socket.connected || !ownsResumeSocket(socket, owner)) return false;
  const credential = Object.freeze({ ...request.credential });
  const binding = await owner.transfer({ credential, expectedGeneration: request.expectedGeneration,
    originalOperationId: request.originalOperationId, transferOperationId: request.transferOperationId });
  return !!binding && publish(socket, owner, members, binding, credential, handoff);
}
// Intentionally NO lookup->admit composition: lookup is not membership and cannot
// distinguish a lost ACK from a concurrent winner. No automatic generation retry.
// This lease also cannot finish browser history synchronization by itself.
