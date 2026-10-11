import type { Socket } from "socket.io";
import type { ResumeSocketOwner } from "./resume-socket";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeOperationGate } from "./resume-operation";
import { ResumeCapacity } from "./resume-capacity";

// Transitional public HTTP admission. The existing x-socket-id remains a
// bearer capability, NOT proof of who initiated HTTP. Do not enable public
// resume until the credential-authenticated upload pipeline replaces this.
// One shared instance per server; no body/parser/filesystem access here.
export class LegacyUploadAdmission {
  private readonly pending = new WeakSet<Socket>();
  constructor(private readonly members: ResumeMemberships,
    private readonly gate: ResumeOperationGate,
    private readonly capacity = new ResumeCapacity(100),
    private readonly now = () => performance.now()) {}

  async authorize(socket: Socket, owner: ResumeSocketOwner, roomId: string) {
    const binding = this.members.bindingFor(socket, owner, roomId);
    if (!binding || this.pending.has(socket)) return null;
    const release = this.capacity.acquire();
    if (!release) return null;
    this.pending.add(socket);
    const started = this.now();
    try {
      const result = await this.gate.run(binding, async () => true);
      const finished = this.now();
      if (!result.authorized || !Number.isFinite(started) || !Number.isFinite(finished) ||
          finished < started || finished - started >= 10_000 ||
          this.members.bindingFor(socket, owner, roomId) !== binding) return null;
      // Caller must recheck this exact binding at its parser handoff boundary.
      return binding;
    } finally {
      // Never release capacity on a timeout race: wait for actual DB settlement.
      this.pending.delete(socket); release();
    }
  }
}
