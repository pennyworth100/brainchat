import { safeEqual } from "./security";

export interface AgentPrincipal {
  accountId: string;
  username: string;
  key: string;
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function loadAgentPrincipals(
  legacyAlfredKey: string | undefined,
  configuredJson: string | undefined
): AgentPrincipal[] {
  const principals: AgentPrincipal[] = [];

  if (legacyAlfredKey) {
    principals.push({ accountId: "alfred", username: "Alfred", key: legacyAlfredKey });
  }

  if (configuredJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configuredJson);
    } catch {
      throw new Error("DIMLE_AGENT_API_KEYS_JSON must contain valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("DIMLE_AGENT_API_KEYS_JSON must be an object");
    }

    for (const [accountId, value] of Object.entries(parsed)) {
      if (!ACCOUNT_ID_PATTERN.test(accountId)) {
        throw new Error(`Invalid agent account ID: ${accountId}`);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid agent account configuration: ${accountId}`);
      }
      const { username, key } = value as Record<string, unknown>;
      if (
        typeof username !== "string" ||
        username.length < 1 ||
        username.length > 64 ||
        typeof key !== "string" ||
        key.length < 16
      ) {
        throw new Error(`Invalid agent account configuration: ${accountId}`);
      }
      principals.push({ accountId, username, key });
    }
  }

  const accountIds = new Set<string>();
  const usernames = new Set<string>();
  const keys = new Set<string>();
  for (const principal of principals) {
    if (accountIds.has(principal.accountId)) {
      throw new Error(`Duplicate agent account ID: ${principal.accountId}`);
    }
    if (usernames.has(principal.username.toLocaleLowerCase("en-US"))) {
      throw new Error(`Duplicate agent username: ${principal.username}`);
    }
    if (keys.has(principal.key)) {
      throw new Error("Agent API keys must be unique");
    }
    accountIds.add(principal.accountId);
    usernames.add(principal.username.toLocaleLowerCase("en-US"));
    keys.add(principal.key);
  }

  return principals;
}

export function authenticateAgent(
  key: string | undefined,
  principals: readonly AgentPrincipal[]
): AgentPrincipal | null {
  if (!key) return null;
  return principals.find((principal) => safeEqual(key, principal.key)) ?? null;
}
