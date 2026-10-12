import type { PoolConfig } from "pg";

// Private candidate only. Never infer an authority from DATABASE_URL/PG*.
export function candidateConfiguration(env: Readonly<Record<string, string | undefined>>, ca: string) {
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw Error("Candidate CA certificate required");
  const names = ["MIGRATION", "RUNTIME", "MAINTENANCE"] as const;
  const urls = names.map(name => {
    let url: URL;
    try { url = new URL(env[`DIMLE_CANDIDATE_${name}_URL`] ?? ""); }
    catch { throw Error(`Invalid candidate ${name} URL`); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        !url.username || !url.password || !url.pathname.slice(1) || url.search || url.hash)
      throw Error(`Invalid candidate ${name} URL`);
    return url;
  });
  const target = (u: URL) => `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  if (new Set(urls.map(target)).size !== 1 || new Set(urls.map(u => decodeURIComponent(u.username))).size !== 3)
    throw Error("Candidate requires one database and three distinct login roles");
  const configs: PoolConfig[] = urls.map(url => ({
    connectionString: url.href, ssl: { ca, rejectUnauthorized: true },
    options: "-c search_path=pg_catalog,public,pg_temp", max: 4,
    connectionTimeoutMillis: 5000, statement_timeout: 15000,
  }));
  return { configs, roles: urls.map(u => decodeURIComponent(u.username)), database: decodeURIComponent(urls[0].pathname.slice(1)) };
}
