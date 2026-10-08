import fs from "node:fs/promises";
import path from "node:path";

export class CursorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = null;
  }

  async load() {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.state = raw && typeof raw === "object" ? raw : {};
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.state = {};
    }
    return this.state;
  }

  async get(roomId) {
    const state = await this.load();
    const value = state[roomId];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async set(roomId, value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Dimle cursor");
    const state = await this.load();
    state[roomId] = value;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }
}
