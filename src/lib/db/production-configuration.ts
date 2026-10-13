import { X509Certificate } from "node:crypto";
import type { PoolConfig } from "pg";

/** Explicit runtime-only configuration. Never reads DATABASE_URL, PG* or
 * candidate/migration credentials. This is not release/capacity authorization. */
export function productionConfiguration(env: Readonly<Record<string, string | undefined>>, ca: string) {
  try { new X509Certificate(ca); } catch { throw Error("Production CA certificate required"); }
  if (env.DIMLE_PRODUCTION_MIGRATION_URL)
    throw Error("Migration credentials forbidden in production runtime configuration");
  const urls = ["RUNTIME", "MAINTENANCE"].map(name => {
    try {
      const u = new URL(env[`DIMLE_PRODUCTION_${name}_URL`] ?? "");
      if (!["postgres:", "postgresql:"].includes(u.protocol) || !u.hostname ||
          !u.username || !u.password || !u.pathname.slice(1) || u.search || u.hash ||
          decodeURIComponent(u.pathname.slice(1)).includes("/")) throw Error();
      decodeURIComponent(u.username); decodeURIComponent(u.password);
      return u;
    } catch { throw Error(`Invalid production ${name} URL`); }
  });
  const target = (u: URL) => `${u.hostname}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1))}`;
  const roles = urls.map(u => decodeURIComponent(u.username));
  if (new Set(urls.map(target)).size !== 1 || new Set(roles).size !== 2)
    throw Error("Production requires one database and two distinct login roles");
  const configs: PoolConfig[] = urls.map(u => ({ connectionString: u.href,
    ssl: { ca, rejectUnauthorized: true }, options: "-c search_path=pg_catalog,public,pg_temp",
    max: 4, connectionTimeoutMillis: 5000, statement_timeout: 15000 }));
  return { configs, roles, database: decodeURIComponent(urls[0].pathname.slice(1)) };
}
