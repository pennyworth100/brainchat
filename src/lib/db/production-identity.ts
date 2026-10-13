import type { Pool } from "pg";

/** Read-only authenticated identity preflight on pools built by
 * productionConfiguration. Snapshot only: does NOT replace catalog/adoption,
 * an all-writer/DDL fence, physical authority or finite capacity activation. */
export async function verifyProductionDatabaseIdentities(pools: readonly Pool[], roles: readonly string[], database: string) {
  if (pools.length !== 2 || new Set(pools).size !== 2 || roles.length !== 2 ||
      new Set(roles).size !== 2 || !database) throw Error("Invalid production identity authorities");
  for (const [i, pool] of pools.entries()) {
    try {
      const ssl = pool.options.ssl;
      if (!ssl || typeof ssl !== "object" || ssl.rejectUnauthorized !== true ||
          !ssl.ca || ssl.checkServerIdentity) throw Error();
      const result = await pool.query(`SELECT current_user,session_user,current_database() AS database,
        current_setting('search_path') AS path,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        rolcanlogin AND rolvaliduntil > clock_timestamp() AND rolvaliduntil < 'infinity'::timestamptz
          AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS restricted,
        NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS isolated,
        NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid) AND
        NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AND
        NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AND
        NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid) AS non_owner,
        NOT EXISTS(SELECT 1 FROM pg_database WHERE datallowconn AND datname<>current_database()
          AND has_database_privilege(current_user,oid,'CONNECT')) AS no_foreign_database,
        NOT has_schema_privilege(current_user,'public','CREATE') AND
        NOT has_schema_privilege(current_user,'drizzle','USAGE,CREATE') AND
        NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP,CONNECT WITH GRANT OPTION') AS no_ddl
        FROM pg_roles r WHERE rolname=current_user`);
      const row = result.rows[0];
      if (!row || row.current_user !== roles[i] || row.session_user !== roles[i] || row.database !== database ||
          row.path !== "pg_catalog,public,pg_temp" || row.tls !== true || row.restricted !== true ||
          row.isolated !== true || row.non_owner !== true || row.no_foreign_database !== true || row.no_ddl !== true)
        throw Error();
      for (const table of ["message_write_budget", "resume_upload_budget", "resume_upload_attempts",
        "upload_resource_domains", "upload_resource_policies", "upload_resource_attempts"]) {
        const access = await pool.query(`SELECT
          has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`, ["public." + table]);
        if (access.rows[0]?.allowed !== false) throw Error();
      }
    } catch { throw Error("Production database identity preflight rejected"); }
  }
}
