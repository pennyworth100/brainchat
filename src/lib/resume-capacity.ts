// Process-local budget for unresolved admission work, NOT active sessions.
export class ResumeCapacity {
  private used = 0;
  constructor(private readonly maximum = 100) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw Error("Invalid admission capacity");
  }
  acquire(): (() => void) | null {
    if (this.used >= this.maximum) return null;
    this.used++;
    let released = false;
    return () => { if (!released) { released = true; this.used--; } };
  }
}
