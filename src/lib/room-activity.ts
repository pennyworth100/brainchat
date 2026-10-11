/** A participant in writer settlement, NOT an admission gate or global fence.
 * Stop every producer before relying on settle(); new work can start afterwards.
 * A failed activity update must not turn a committed message into a retry signal.
 */
export class RoomActivityWriter {
  private readonly pending = new Set<Promise<void>>();
  private failedWrites = 0;

  constructor(private readonly update: (roomId: string) => PromiseLike<unknown>) {}

  touch(roomId: string): Promise<void> {
    // Register before invoking user code, including synchronous throws/reentry.
    const task = Promise.resolve().then(() => this.update(roomId)).then(
      () => {},
      () => { this.failedWrites++; },
    );
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
    return task;
  }

  async settle(): Promise<{ failedWrites: number }> {
    // Recheck: another already-admitted handler can enqueue while we wait.
    while (this.pending.size) await Promise.all(this.pending);
    return { failedWrites: this.failedWrites };
  }
}
