/** Browser memory only. A legacy grant must be explicit, never inferred from
 * absent/partial bearer fields. This is NOT server authorization. */
export type UploadAuthority =
  | Readonly<{ kind: "legacy"; roomId: string; socketId: string }>
  | Readonly<{ kind: "resume"; roomId: string; socketId: string;
      sessionId: string; token: string }>;

export function uploadAuthorityHeaders(authority: UploadAuthority | null,
  roomId: string, socketId: string, clientMessageId: string): Readonly<Record<string, string>> {
  if (!authority || authority.roomId !== roomId || authority.socketId !== socketId ||
      !socketId || !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId)) {
    throw Error("Upload authority changed. Please rejoin the room.");
  }
  const headers: Record<string, string> = { "x-room-id": roomId, "x-socket-id": socketId };
  if (authority.kind === "resume") {
    if (typeof authority.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(authority.sessionId) ||
        typeof authority.token !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(authority.token)) {
      throw Error("Upload credential rejected.");
    }
    headers["x-resume-session-id"] = authority.sessionId;
    headers["x-resume-token"] = authority.token;
    headers["x-client-message-id"] = clientMessageId;
  } else if (authority.kind !== "legacy" || "sessionId" in authority || "token" in authority) {
    throw Error("Upload credential rejected.");
  }
  return Object.freeze(headers);
}
