import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAgent, loadAgentPrincipals } from "./agent-api-auth";

test("legacy Alfred key remains compatible", () => {
  const principals = loadAgentPrincipals("legacy-alfred-key", undefined);
  assert.deepEqual(principals, [
    { accountId: "alfred", username: "Alfred", key: "legacy-alfred-key" },
  ]);
  assert.equal(authenticateAgent("legacy-alfred-key", principals)?.username, "Alfred");
});

test("multiple agents authenticate as separate server-owned identities", () => {
  const principals = loadAgentPrincipals(undefined, JSON.stringify({
    alfred: { username: "Alfred", key: "alfred-key-123456" },
    elon: { username: "Elon", key: "elon-key-12345678" },
  }));
  assert.equal(authenticateAgent("alfred-key-123456", principals)?.accountId, "alfred");
  assert.equal(authenticateAgent("elon-key-12345678", principals)?.username, "Elon");
  assert.equal(authenticateAgent("wrong-key", principals), null);
});

test("unsafe or ambiguous agent configuration fails closed", () => {
  assert.throws(() => loadAgentPrincipals(undefined, "not-json"), /valid JSON/);
  assert.throws(
    () => loadAgentPrincipals(undefined, JSON.stringify({ Elon: { username: "Elon", key: "long-enough-secret" } })),
    /account ID/
  );
  assert.throws(
    () => loadAgentPrincipals("same-secret-key-123", JSON.stringify({ elon: { username: "Elon", key: "same-secret-key-123" } })),
    /unique/
  );
});
