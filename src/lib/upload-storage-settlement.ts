import type { Request } from "express";
import type { StorageEngine } from "multer";

/** Retain late storage and abort cleanup even after Multer calls next(error).
 * This proves callback settlement, not filesystem durability or quota authority.
 */
export class UploadStorageSettlement {
  private readonly pending = new WeakMap<Request, Set<Promise<void>>>();
  wrap(engine: StorageEngine): StorageEngine {
    return {
      _handleFile: (req, file, callback) => this.observe(req, done =>
        engine._handleFile(req, file, (...args) => {
          try { callback(...args); } finally { done(); }
        })),
      _removeFile: (req, file, callback) => this.observe(req, done =>
        engine._removeFile(req, file, (...args) => {
          try { callback(...args); } finally { done(); }
        })),
    };
  }
  private observe(req: Request, work: (done: () => void) => void): void {
    let tasks = this.pending.get(req);
    if (!tasks) { tasks = new Set(); this.pending.set(req, tasks); }
    const owned = tasks;
    let resolve!: () => void;
    const task = new Promise<void>(r => { resolve = r; });
    owned.add(task);
    const done = () => { owned.delete(task); resolve(); };
    try { work(done); } catch (error) { done(); throw error; }
  }
  async settle(req: Request): Promise<void> {
    const tasks = this.pending.get(req);
    // A late _handleFile callback can synchronously start abort _removeFile.
    while (tasks?.size) await Promise.all(tasks);
    this.pending.delete(req);
  }
}
