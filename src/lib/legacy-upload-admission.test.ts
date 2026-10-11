import assert from "node:assert/strict";
import test from "node:test";
import type { Socket } from "socket.io";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeSocketOwner } from "./resume-socket";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeOperationGate } from "./resume-operation";
import { ResumeCapacity } from "./resume-capacity";
import { LegacyUploadAdmission } from "./legacy-upload-admission";

// Deterministic scheduling/clock faults; actual authority/HTTP/PG are exercised
// separately by qa-public-session.ts, not inferred from these fakes.
for (const mode of ["deadline", "clock-backwards", "nonfinite", "denied", "throw", "replacement", "success"] as const) {
  test(`legacy HTTP admission settles before release: ${mode}`, async () => {
    const socket = {} as Socket, second = {} as Socket, owner = {} as ResumeSocketOwner;
    const binding = Object.freeze({ roomId: "files123", username: "Alice" }) as ResumeBinding;
    let current = binding, now = 100;
    const members = { bindingFor: () => current } as unknown as ResumeMemberships;
    let settle!: () => void;
    const waiting = new Promise<void>(resolve => { settle = resolve; });
    let calls = 0;
    const gate = { run: async () => {
      calls++; await waiting;
      if (mode === "throw") throw Error("database unavailable");
      return { authorized: mode !== "denied", value: true };
    } } as unknown as ResumeOperationGate;
    const capacity = new ResumeCapacity(1);
    const admission = new LegacyUploadAdmission(members, gate, capacity, () => now);
    const pending = admission.authorize(socket, owner, "files123");
    assert.equal(await admission.authorize(socket, owner, "files123"), null);
    assert.equal(await admission.authorize(second, owner, "files123"), null);
    if (mode === "deadline") now += 10_000;
    if (mode === "clock-backwards") now--;
    if (mode === "nonfinite") now = NaN;
    if (mode === "replacement") current = Object.freeze({ ...binding });
    assert.equal(capacity.acquire(), null, "even a deadline cannot release unresolved DB work");
    settle();
    if (mode === "throw") await assert.rejects(pending, /database unavailable/);
    else assert.equal(await pending, mode === "success" ? binding : null);
    assert.equal(calls, 1);
    const release = capacity.acquire(); assert.ok(release); release();
    now = 100; current = binding;
    if (mode === "throw") await assert.rejects(admission.authorize(socket, owner, "files123"));
    else await admission.authorize(socket, owner, "files123");
    assert.equal(calls, 2, "pending identity clears only after settlement");
  });
}
