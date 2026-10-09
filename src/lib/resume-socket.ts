import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { ResumeAdmission } from "./resume-admission";
import { ResumeCapacity } from "./resume-capacity";
import type { ResumeBindings, ResumeBinding } from "./resume-bindings";
import type { ResumeIdentity, ResumeStore, ResumeCredential } from "./resume-store";
import { isValidRoomId } from "./room-id";
import type { ResumeMemberships } from "./resume-membership";

type Options = {
  store: Pick<ResumeStore, "advanceGeneration">;
  bindings: ResumeBindings;
  // No room membership, history, presence or other outbound access here.
  prepare: (identity: ResumeIdentity) => Promise<() => Promise<void>>;
  onCleanupError: (error: unknown) => void;
  capacity?: ResumeCapacity;
  timeoutMs?: number;
  // Trusted server-authenticated input only; never wire directly to client data.
  issue?: ResumeStore["issueAfterAuthenticatedJoin"];
  issueCapacity?: ResumeCapacity;
  // Opt-in private composition. Shared with this exact bindings registry.
  memberships?: Pick<ResumeMemberships, "install">;
  // Private, trusted one-shot publication; part of the same join deadline/flight.
  publishJoin?: (binding: ResumeBinding, live: () => boolean) => Promise<boolean>;
  // No new joined notice. Runs after membership install, inside admission limits.
  publishResume?: (binding: ResumeBinding, live: () => boolean) => Promise<boolean>;
};
export type ResumeSocketOwner = Readonly<{
  incarnation: string;
  admit: (request: Parameters<ResumeAdmission["admit"]>[0]) => Promise<ResumeBinding | null>;
  join: (authenticated: { roomId: string; username: string; authVersion: number }) =>
    Promise<Readonly<{ credential: Readonly<ResumeCredential>; binding: ResumeBinding }> | null>;
  close: () => Promise<void>;
}>;

// Key by the actual server Socket object, NEVER socket.id, handshake or client ID.
// Keep closed owners until the socket is collected: reattachment cannot reopen it.
const owners = new WeakMap<Socket, { options: Options; owner: ResumeSocketOwner;
  subscribe: (release: () => void) => (() => void) | null }>();
const capacity = new ResumeCapacity(100);
const issuanceCapacity = new ResumeCapacity(100);

// Server-object identity check; never accept a copied owner or a different socket.
export function ownsResumeSocket(socket: Socket, owner: ResumeSocketOwner): boolean {
  return owners.get(socket)?.owner === owner;
}

// Private exact-owner lifecycle hook. Closed owners cannot acquire new leases.
// Releases are synchronous; async preparation cleanup stays in admission.
export function onResumeSocketClose(socket: Socket, owner: ResumeSocketOwner,
  release: () => void): (() => void) | null {
  const record = owners.get(socket);
  return record?.owner === owner ? record.subscribe(release) : null;
}

// PRIVATE, not registered by server.ts. One module instance in one server process.
// Repeated installation requires the same options object; a competing installer
// fails before creating an admission, listener or incarnation.
export function attachResumeSocket(socket: Socket, options: Options): ResumeSocketOwner {
  const previous = owners.get(socket);
  if (previous) {
    if (previous.options !== options) throw Error("Socket already has a resume owner");
    return previous.owner;
  }
  const { store, bindings, prepare, onCleanupError } = options;
  if (options.publishResume && !options.memberships) throw Error("Resume publication requires memberships");
  const incarnation = randomUUID();
  let mode: "join" | "resume" | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const releases = new Set<() => void>();
  const admission = new ResumeAdmission(store, bindings, incarnation,
    () => !closed && socket.connected, prepare, {
      capacity: options.capacity ?? capacity, timeoutMs: options.timeoutMs ?? 10_000,
      onLateError: onCleanupError,
    }, options.memberships ? async (binding, live) => {
      try {
        if (live() && options.memberships!.install(socket, owner, binding) &&
            (mode === "join" || !options.publishResume || await options.publishResume(binding, live)) && live()) {
          return true;
        }
      } catch (error) { terminate(); throw error; }
      terminate(); return false;
    } : undefined);
  const close = () => {
    closed = true; // synchronous permanent fence, even if CAS/prepare never settles
    socket.off("disconnecting", onDisconnect);
    const result = closing ??= admission.close();
    // Publish the promise before callbacks, allowing reentrant close.
    const callbacks = [...releases];
    releases.clear();
    for (const release of callbacks) {
      try { release(); }
      catch (error) {
        try { onCleanupError(error); }
        catch (reportError) { console.error("Resume cleanup error reporter failed", reportError); }
      }
    }
    return result;
  };
  let observingClose = false;
  const closeAutomatically = () => {
    const result = close();
    if (observingClose) return;
    observingClose = true;
    void result.catch(error => {
      // close() retains the original rejected promise for an explicit await.
      try { onCleanupError(error); }
      catch (reportError) { console.error("Resume cleanup error reporter failed", reportError); }
    });
  };
  const onDisconnect = closeAutomatically;
  const memberships = options.memberships;
  const flights = new WeakMap<Promise<ResumeBinding | null>, Promise<ResumeBinding | null>>();
  const terminate = () => {
    // Fence/release synchronously; never wait for stalled CAS or cleanup before
    // physical disconnection. close retains the original cleanup result.
    closeAutomatically();
    socket.disconnect(true);
  };
  const admitInternal: ResumeSocketOwner["admit"] = request => {
    const flight = admission.admit(request);
    if (!mode && admission.ownsAttempt(flight)) mode = "resume";
    if (!memberships || !admission.ownsAttempt(flight)) return flight;
    const previous = flights.get(flight);
    if (previous) return previous;
    const result = flight.then(binding => {
      try {
        if (binding && !closed && socket.connected && bindings.isCurrent(binding)) return binding;
      } catch (error) {
        terminate();
        throw error;
      }
      terminate();
      return null;
    }, error => { terminate(); throw error; });
    flights.set(flight, result);
    return result;
  };
  const admit: ResumeSocketOwner["admit"] = request => {
    if (mode === "join") return Promise.resolve(null);
    return admitInternal(request);
  };
  let joinKey: string | undefined;
  let joinFlight: ReturnType<ResumeSocketOwner["join"]> | undefined;
  let joined: ResumeBinding | undefined;
  const join: ResumeSocketOwner["join"] = authenticated => {
    const { roomId, username, authVersion } = authenticated;
    if (closed || !socket.connected || mode === "resume" || !options.issue || !memberships ||
        typeof roomId !== "string" || !isValidRoomId(roomId) || typeof username !== "string" ||
        !username.trim() || username.length > 64 || !Number.isSafeInteger(authVersion) || authVersion < 1) {
      return Promise.resolve(null);
    }
    const key = JSON.stringify([roomId, username, authVersion]);
    if (joinFlight) return key === joinKey && (!joined || bindings.isCurrent(joined))
      ? joinFlight : Promise.resolve(null);
    mode = "join"; joinKey = key; // reserve before any hook or asynchronous work
    const release = (options.issueCapacity ?? issuanceCapacity).acquire();
    if (!release) { terminate(); return joinFlight = Promise.resolve(null); }
    const deadline = performance.now() + (options.timeoutMs ?? 10_000);
    const live = () => !closed && socket.connected && performance.now() < deadline;
    let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    const work = Promise.resolve().then(async () => {
      if (!live()) return null;
      const issued = await options.issue!(roomId, username, authVersion);
      if (!live() || !issued || issued.roomId !== roomId || issued.username !== username ||
          issued.authVersion !== authVersion || issued.generation !== 0) return null;
      const credential = Object.freeze({ roomId, sessionId: issued.sessionId, token: issued.token });
      const binding = await admitInternal({ credential, expectedGeneration: 0, operationId: randomUUID() });
      if (!live() || !binding || !bindings.isCurrent(binding)) return null;
      joined = binding;
      if (options.publishJoin && !await options.publishJoin(binding,
        () => live() && bindings.isCurrent(binding))) return null;
      if (!live() || !bindings.isCurrent(binding)) return null;
      return Object.freeze({ credential, binding });
    });
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { timedOut = true; terminate(); resolve(null); }, options.timeoutMs ?? 10_000);
    });
    const settled = work.then(value => {
      clearTimeout(timer); release();
      if (!value) terminate();
      return value;
    }, error => {
      clearTimeout(timer); release(); terminate();
      if (timedOut) {
        try { onCleanupError(error); }
        catch (reportError) { console.error("Join late error reporter failed", reportError); }
      }
      throw error;
    });
    return joinFlight = Promise.race([settled, timeout]);
  };
  const owner: ResumeSocketOwner = Object.freeze({ incarnation, admit, join, close });
  owners.set(socket, { options, owner, subscribe: release => {
    if (closed) return null;
    releases.add(release);
    return () => { releases.delete(release); };
  } });
  // Fence before Socket.IO removes rooms and emits its later disconnect event.
  socket.once("disconnecting", onDisconnect);
  if (!socket.connected) onDisconnect();
  return owner;
}
