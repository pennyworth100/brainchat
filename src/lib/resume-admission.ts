import { ResumeBindings, type ResumeBinding } from "./resume-bindings";
import { hashResumeToken, type ResumeCredential, type ResumeIdentity, type ResumeStore } from "./resume-store";

type Request = { credential: ResumeCredential; expectedGeneration: number; operationId: string };
type Cleanup = () => Promise<void>;

// PRIVATE seam: create exactly ONCE per physical server connection, never per
// request. Do not mix ordinary joins or direct bindings on that connection.
// A failed/uncertain attempt is terminal for this incarnation; reconnect with a
// new server ID to explicitly recover. No automatic CAS replay or public use.
export class ResumeAdmission {
  private closed = false;
  private key: string | undefined;
  private flight: Promise<ResumeBinding | null> | undefined;
  private binding: ResumeBinding | undefined;
  private cleanup: Cleanup | undefined;

  constructor(private readonly store: Pick<ResumeStore, "advanceGeneration">,
    private readonly bindings: ResumeBindings, private readonly transportId: string,
    private readonly connected: () => boolean,
    // Preparation must not publish history/presence or grant outbound access.
    // It returns an EXACT lease cleanup; if it throws it must clean partial work.
    private readonly prepare: (identity: ResumeIdentity) => Promise<Cleanup>) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(transportId)) throw Error("Invalid transport incarnation");
  }

  private live() {
    try { return !this.closed && this.connected(); } catch { return false; }
  }

  admit(request: Request): Promise<ResumeBinding | null> {
    if (!this.live()) return Promise.resolve(null);
    const credential = { ...request.credential };
    const tokenHash = hashResumeToken(credential.token);
    if (!tokenHash) return Promise.resolve(null);
    const { expectedGeneration, operationId } = request;
    const key = JSON.stringify([credential.sessionId, credential.roomId, tokenHash,
      expectedGeneration, operationId]);
    if (this.flight) {
      if (key !== this.key || (this.binding && !this.bindings.isCurrent(this.binding))) {
        return Promise.resolve(null);
      }
      return this.flight; // including rejection: uncertainty never reruns DB
    }
    // Reserve synchronously, BEFORE invoking any asynchronous or reentrant hook.
    this.key = key;
    this.flight = Promise.resolve().then(async () => {
      if (!this.live()) return null;
      const identity = await this.store.advanceGeneration(credential,
        expectedGeneration, operationId, this.transportId);
      if (!identity || !this.live() || identity.sessionId !== credential.sessionId ||
          identity.roomId !== credential.roomId || identity.generation !== expectedGeneration + 1) return null;
      try {
        const binding = await this.bindings.activate(identity, this.transportId, async () => {
          this.cleanup = await this.prepare(identity);
        }, () => this.live());
        // activate can finish before this continuation resumes: recheck authority.
        if (!binding || !this.live() || !this.bindings.isCurrent(binding)) {
          if (binding) this.bindings.detach(binding);
          await this.dispose();
          return null;
        }
        this.binding = binding;
        return binding;
      } catch (error) {
        await this.dispose();
        throw error;
      }
    });
    return this.flight;
  }

  private async dispose() {
    const cleanup = this.cleanup;
    this.cleanup = undefined;
    if (cleanup) await cleanup();
  }

  async close(): Promise<void> {
    // Permanent fence is synchronous, even if DB/prepare has not completed.
    this.closed = true;
    if (this.binding) this.bindings.detach(this.binding);
    if (this.flight) {
      // Preserve failure to the original caller, but still release acquired lease.
      try { await this.flight; } catch { /* no replay */ }
    }
    await this.dispose();
  }
}
