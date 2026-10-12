import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { candidateConfiguration } from "./src/lib/db/candidate-configuration";
import { configureCandidateRuntime } from "./src/lib/db/candidate-runtime";
import { installProcessShutdown } from "./src/lib/process-shutdown";

// Explicit private deployment command. No fallback to production DATABASE_URL,
// no public resume activation, no grant/role/budget provisioning.
async function start() {
  const ca = readFileSync(process.env.DIMLE_CANDIDATE_CA_FILE ?? "", "utf8");
  const { configs, roles, database } = candidateConfiguration(process.env, ca);
  configureCandidateRuntime(configs[1]);
  const { pool } = await import("./src/lib/db");
  const migrations = new Pool(configs[0]), maintenance = new Pool(configs[2]);
  const pools = [migrations, pool, maintenance];
  let startupEntered = false;
  try {
    // Real authenticated identity and server-side TLS before ANY migration.
    for (let i = 0; i < pools.length; i++) {
      const result = await pools[i].query(`SELECT current_user,session_user,current_database() AS database,
        current_setting('search_path') AS path,
        NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS restricted,
        NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS no_memberships,
        NOT EXISTS(SELECT 1 FROM pg_database WHERE datallowconn AND datname<>current_database()
          AND has_database_privilege(current_user,oid,'CONNECT')) AS no_foreign_database,
        (SELECT datdba=r.oid FROM pg_database WHERE datname=current_database()) AS database_owner,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AND
        NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AND
        NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid) AND
        NOT has_schema_privilege(current_user,'public','CREATE') AND
        NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP') AS non_owner
        FROM pg_roles r WHERE rolname=current_user`);
      const row = result.rows[0];
      if (!row || row.current_user !== roles[i] || row.session_user !== roles[i] || row.database !== database ||
          row.path !== 'pg_catalog,public,pg_temp' || !row.restricted || !row.no_memberships || !row.tls ||
          !row.no_foreign_database || (i === 0 ? !row.database_owner : !row.non_owner))
        throw Error("Candidate database preflight rejected");
      if (i !== 0) {
        for (const table of ['message_write_budget','resume_upload_budget','resume_upload_attempts',
          'upload_resource_domains','upload_resource_policies','upload_resource_attempts']) {
          const access = await pools[i].query(`SELECT
            has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
            has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`,['public.'+table]);
          if (access.rows[0]?.allowed !== false) throw Error("Candidate budget privilege rejected");
        }
      }
    }
    const { main } = await import("./server");
    startupEntered = true;
    const runtime = await main({databaseAuthorities:{migrations,maintenance,publicationTables:true}});
    installProcessShutdown(process, async () => {
      const report = await runtime.lifecycle.stopAndSettle();
      await runtime.settleStrictUploads();
      await new Promise<void>((resolve,reject) => runtime.io.close(error => error ? reject(error) : resolve()));
      await runtime.app.close();
      await Promise.all(pools.map(p => p.end()));
      return report;
    }, event => {
      // Do not log driver errors/URLs/credentials.
      console.log("Dimle candidate shutdown " + event);
      if (event === "failed") process.exitCode = 1;
    });
  } catch {
    // A rejected main may represent failed lifecycle/ledger settlement. Never
    // close authority pools underneath unconfirmed work; let the operator
    // recover this failed candidate. Preflight has not started any work.
    if (!startupEntered) await Promise.allSettled(pools.map(p => p.end()));
    throw Error("Candidate startup failed; details withheld to protect credentials");
  }
}
void start().catch(() => { console.error("Dimle candidate startup rejected"); process.exitCode = 1; });
