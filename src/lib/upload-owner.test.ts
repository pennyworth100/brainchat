import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { Server } from "socket.io";
import { io } from "socket.io-client";
import { createRoomSession } from "./room-session";
import { uploadRoomFile } from "./upload-client";

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

for (const phase of ["headers", "body"]) {
for (const status of [200, 401]) {
  for (const replacement of ["same", "different", "disposed", "transport-only"]) {
    test(`upload HTTP ${status} ${phase}: ${replacement} cannot transfer operation ownership`, async t => {
      let release!: () => void;
      const requests: string[] = [];
      let joins = 0;
      const server = http.createServer();
      // Real room/session transport; controlled HTTP completion allows exact
      // scheduling without relying on operating-system network timing.
      const request: typeof fetch = async (_url, options) => {
        const transport = sockets.sockets.sockets.get((options!.headers as Record<string, string>)["x-socket-id"]);
        requests.push(transport?.data.username ?? "missing");
        const respond = (code: number) => Response.json(code === 401 ? { code: "UPLOAD_AUTH_REQUIRED" } : {
          message: { id: 1, type: "file", username: "original", name: "proof.txt", ts: 1 },
        }, { status: code });
        if (requests.length === 1) {
          if (phase === "headers") return new Promise(resolve => { release = () => resolve(respond(status)); });
          const response = respond(status);
          const json = response.json.bind(response);
          response.json = () => new Promise(resolve => { release = () => { void json().then(resolve); }; });
          return response;
        }
        return respond(200);
      };
      const sockets = new Server(server);
      sockets.on("connection", socket => {
        socket.on("join-room", credentials => {
          joins++; socket.data.username = credentials.username;
          socket.emit("room-snapshot", { history: [], users: [] });
        });
        socket.on("sync-room", (_payload, ack) => ack({ history: [], users: [] }));
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const socket = io(origin);
      const session = createRoomSession(socket, {
        onState() {}, onSnapshot() {}, onJoined() {}, onError: assert.fail,
      }, 300);
      t.after(async () => {
        session.dispose(); socket.disconnect();
        server.closeAllConnections();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
      });
      session.join({ roomId: "same", username: "original" });
      await waitFor(() => session.isReady());
      const result = uploadRoomFile(new File(["proof"], "proof.txt"), "same", session,
        request);
      const outcome = result.then(value => ({ value, error: "" }), (error: Error) => ({ value: null, error: error.message }));
      await Promise.race([waitFor(() => !!release), outcome.then(x => { throw Error("upload ended before first request: " + x.error); })]);
      if (replacement === "disposed") session.dispose();
      else if (replacement === "transport-only") await session.reconnect();
      else {
        session.join({ roomId: replacement, username: "replacement" });
        await waitFor(() => session.isReady());
      }
      const joinsBefore = joins;
      release();
      const settled = await outcome;
      t.diagnostic(JSON.stringify({ requests, joinsBefore, joinsAfter: joins, error: settled.error }));
      if (replacement === "transport-only") {
        assert.equal(settled.error, "");
        assert.deepEqual(requests, status === 401 ? ["original", "original"] : ["original"]);
      } else {
        assert.match(settled.error, /Room (changed|closed)/, "old receipt must not publish to replacement UI");
        assert.deepEqual(requests, ["original"], "old body must never retry as replacement identity");
        assert.equal(joins, joinsBefore, "old auth rejection must not reconnect the replacement");
      }
    });
  }
}
}
