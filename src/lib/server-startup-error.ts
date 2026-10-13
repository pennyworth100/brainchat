/** Only emitted after application startup resources actually settle. A cleanup
 * failure must propagate as itself, so the caller retains its authority pools. */
export class SettledServerStartupError extends Error {
  constructor(cause: unknown) {
    super("Server startup rejected after settlement", { cause });
  }
}
