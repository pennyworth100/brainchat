/** Operator-only, effective privilege audit. No grants or login changes. */
export async function auditCatalogReader(client, reader) {
  const {rows} = await client.query(`SELECT oid::int,rolname,rolcanlogin,rolsuper,
    rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,
    rolvaliduntil > clock_timestamp() AND rolvaliduntil <= clock_timestamp() + interval $$24 hours$$ AS fresh
    FROM pg_roles WHERE rolname=$1`, [reader.name]);
  const r=rows[0];
  if (!r || r.oid!==reader.oid || !r.rolcanlogin || r.rolsuper || r.rolcreatedb ||
      r.rolcreaterole || r.rolreplication || r.rolbypassrls || r.rolinherit || !r.fresh)
    throw Error("Catalog reader principal mismatch");
  const queries = [
    `SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1`,
    // Reject ownership including shared objects and objects in other databases.
    `SELECT 1 FROM pg_shdepend WHERE refclassid=$$pg_authid$$::regclass AND refobjid=$1 AND deptype=$$o$$`,
    `SELECT 1 WHERE NOT has_database_privilege($1::oid,current_database(),$$CONNECT$$)
      OR has_database_privilege($1::oid,current_database(),$$CREATE,TEMP$$)`,
    `SELECT 1 FROM pg_namespace WHERE has_schema_privilege($1::oid,oid,$$CREATE$$)`,
    `SELECT oid::regclass AS object FROM pg_class WHERE relkind IN ($$r$$,$$p$$,$$v$$,$$m$$,$$f$$)
      AND (has_table_privilege($1::oid,oid,$$INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES$$)
        OR has_any_column_privilege($1::oid,oid,$$INSERT,REFERENCES$$)
        OR (oid<>$$pg_catalog.pg_settings$$::regclass AND
          (has_table_privilege($1::oid,oid,$$UPDATE$$) OR has_any_column_privilege($1::oid,oid,$$UPDATE$$)))
        OR (relkind IN ($$v$$,$$f$$) AND relnamespace NOT IN
          ($$pg_catalog$$::regnamespace,$$information_schema$$::regnamespace)
          AND (has_table_privilege($1::oid,oid,$$SELECT$$) OR has_any_column_privilege($1::oid,oid,$$SELECT$$))))`,
    `SELECT 1 FROM pg_class WHERE CASE WHEN relkind=$$S$$ THEN has_sequence_privilege($1::oid,oid,$$USAGE,UPDATE$$) ELSE false END`,
    // Non-trigger user code can run indirectly through casts/type I/O even
    // without EXECUTE. The release necessarily contains PL/pgSQL triggers.
    // That built-in handler rejects non-trigger invocation; this reader cannot
    // cause a DML trigger (all writes denied). Do not extend this exception to
    // C/custom languages or ordinary routines.
    `SELECT 1 FROM pg_proc WHERE pronamespace NOT IN
      ($$pg_catalog$$::regnamespace,$$information_schema$$::regnamespace)
      AND NOT (prokind=$$f$$ AND prorettype=$$pg_catalog.trigger$$::regtype
        AND pronargs=0 AND prolang IN (SELECT oid FROM pg_language WHERE lanname=$$plpgsql$$ AND lanpltrusted)
        AND NOT has_function_privilege($1::oid,oid,$$EXECUTE$$))`,
    // Large-object/WAL mutators bypass ordinary table ACLs. Provisioning must
    // explicitly remove PUBLIC execution; this audit never changes grants.
    `SELECT proname FROM pg_proc WHERE pronamespace=$$pg_catalog$$::regnamespace
      AND proname IN ($$lo_create$$,$$lo_creat$$,$$lo_from_bytea$$,$$lo_put$$,
        $$lo_import$$,$$lo_unlink$$,$$lowrite$$,$$lo_truncate$$,$$lo_truncate64$$,$$pg_logical_emit_message$$)
      AND has_function_privilege($1::oid,oid,$$EXECUTE$$)`
  ];
  // MAINTAIN was added in PostgreSQL 17; it permits physical mutations.
  if (Number((await client.query("SHOW server_version_num")).rows[0].server_version_num)>=170000)
    queries.push(`SELECT oid::regclass AS object FROM pg_class WHERE has_table_privilege($1::oid,oid,$$MAINTAIN$$)`);
  for (const [index,sql] of queries.entries()) {
    const result=await client.query(sql,sql.includes("$1") ? [reader.oid] : []);
    if (result.rowCount) throw Error("Catalog reader has unsafe effective authority: check "+index+" "+JSON.stringify(result.rows));
  }
}
