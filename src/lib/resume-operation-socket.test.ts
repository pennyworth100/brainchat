import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeOperationGate, ResumeUploadOperationGate } from "./resume-operation";

for (const kind of ["socket", "upload"] as const) {
  for (const phase of ["work", "validation", "commit", "release"] as const) {
    test(kind + " gate owns error event during " + phase, async () => {
      const bindings = new ResumeBindings();
      const binding = await bindings.activate({ sessionId: "fixture", roomId: "local986", username: "Guest",
        authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
      "transport_socket_test", async () => {}, () => true);
      assert.ok(binding);
      const admissions = new ResumeUploadAdmissions(bindings), grant = admissions.admit(binding)!;
      const emitter = new EventEmitter(), failure = Error("owned connection loss");
      const otherOwner = () => {};
      emitter.on("error", otherOwner);
      const queries: string[] = [];
      let validations = 0, released: boolean | undefined;
      const client = Object.assign(emitter, {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("SELECT s.id")) {
            validations++;
            if (phase === "validation" && validations === 2) emitter.emit("error", failure);
          }
          if (phase === "commit" && sql === "COMMIT") emitter.emit("error", failure);
          // Event alone must fail closed even if an adapter resolves a query.
          return { rowCount: 1 };
        },
        release: (destroy: boolean) => {
          released = destroy;
          assert.equal(emitter.listenerCount("error"), 2, "owned through release");
          if (phase === "release") emitter.emit("error", failure);
        },
      }) as unknown as PoolClient;
      const pool = { connect: async () => client };
      const work = async () => {
        if (phase === "work") { await Promise.resolve(); emitter.emit("error", failure); }
        return "must not publish";
      };
      const result = kind === "socket"
        ? await new ResumeOperationGate(pool, bindings).runWithOutcome(binding, work)
        : await new ResumeUploadOperationGate(pool, admissions).runWithOutcome(grant, work);
      assert.ok(!result.completed);
      assert.equal(result.error, failure);
      const dispatched = phase === "commit" || phase === "release";
      assert.equal(result.commit, dispatched ? "unknown" : "not-dispatched");
      assert.equal(queries.filter(q => q === "COMMIT").length, dispatched ? 1 : 0);
      assert.equal(released, phase !== "release");
      assert.deepEqual(emitter.listeners("error"), [otherOwner]);
      assert.equal(admissions.admit(binding), null, "gate never releases upload admission");
    });
  }
}
