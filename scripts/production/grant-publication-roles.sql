-- OFFLINE owner-only grants. No role creation, budget allocation or activation.
-- Same authenticated session must set dimle.cutover_runtime and
-- dimle.cutover_maintenance (role names, not credentials).
BEGIN;
-- Include history edits that settle while the history lock is awaited.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(1145654604, 1);
DO $$
DECLARE
  runtime_name text := current_setting('dimle.cutover_runtime', true);
  maintenance_name text := current_setting('dimle.cutover_maintenance', true);
  target text;
  target_oid oid;
BEGIN
  IF runtime_name IS NULL OR maintenance_name IS NULL OR runtime_name = maintenance_name
     OR current_user IN (runtime_name, maintenance_name) THEN
    RAISE EXCEPTION 'Distinct explicit cutover roles required';
  END IF;
  IF current_user <> session_user OR NOT EXISTS (SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datdba=r.oid
      WHERE r.rolname=current_user AND d.datname=current_database()
      AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)) THEN
    RAISE EXCEPTION 'Restricted database owner required';
  END IF;
  -- Exact release history, not a row-count proxy for compatibility. The shared
  -- advisory lock coordinates migration tools; this lock also fences SQL edits.
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE MODE;
  IF EXISTS (
    WITH expected(hash,created_at) AS (VALUES
      ('913a9faea74504034f6a01494735b1defa0e897bca5931b49d0c275058175673', 1773719287776::bigint),
      ('590e22ddc593733f18561d8f518a0370728f9e93adc91eb01693b5f696165713', 1790964448488::bigint),
      ('9d565c00dc53b87a1297fe8c484f5409045d32f8c1fe2ce70469c440cb496b39', 1790964590623::bigint),
      ('c9c819dd363ebcebd0a8c82f2ff11995a3bdb7e8776b070cf17abd973553d5ec', 1791428478021::bigint),
      ('3d125e3a93ff3d523a6035e583f769acd842b710919abc86509f92950acd1fba', 1791497873756::bigint),
      ('23cd023887f7fdeb3ca304bd2a794bde4a079beed692e60ed2458c35abc8aab5', 1791499083632::bigint),
      ('2bf24e48f7016de8651ad23c0cea3c0247f12d5e76ea46b49658ea134cc7edfd', 1791505380692::bigint),
      ('854baac20541606365f9bfce15584b100b9f183c854afd99e7b503dd6ec7f27f', 1791506670335::bigint),
      ('33a4d66ae0f1e228f601d41dbdd93eb10fcd44769488cc171a10c71f5accdfc5', 1791564893022::bigint),
      ('8838d2eacc7cdd4e6f9eb701a72db374dc696c81f4d436c85d30eb983c257e8d', 1791612755512::bigint),
      ('3182b2d5e66728bf27111f0351ce9e5c9a83fd17bc69bb6390425a272850efe6', 1791702805970::bigint)
    ), actual AS (SELECT hash,created_at FROM drizzle.__drizzle_migrations)
    SELECT 1 FROM (
      (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
      UNION ALL
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
    ) AS mismatch
  ) THEN
    RAISE EXCEPTION $reason$Exact release migration history required$reason$;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle') AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) THEN
    RAISE EXCEPTION 'Application object ownership mismatch';
  END IF;
  IF (SELECT count(*) FROM message_write_budget WHERE id AND used_rows=max_rows AND used_bytes=max_bytes) <> 1 THEN
    RAISE EXCEPTION 'Closed publication budget required';
  END IF;
  FOREACH target IN ARRAY ARRAY[runtime_name, maintenance_name] LOOP
    SELECT oid INTO target_oid FROM pg_roles WHERE rolname=target AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit);
    IF target_oid IS NULL OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=target_oid OR roleid=target_oid)
       OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=target_oid)
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=target_oid)
       OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=target_oid)
       OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner=target_oid)
       OR has_database_privilege(target,current_database(),'CREATE,TEMP')
       OR NOT has_database_privilege(target,current_database(),'CONNECT')
       OR EXISTS (SELECT 1 FROM pg_database WHERE datallowconn AND datname<>current_database()
          AND has_database_privilege(target,oid,'CONNECT'))
       OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
          AND has_schema_privilege(target,oid,'CREATE')) THEN
      RAISE EXCEPTION 'Cutover role is not isolated';
    END IF;
    -- Effective privilege checks include PUBLIC and column grants. Reject dirty
    -- roles instead of guessing which privileges are safe to revoke.
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f')
        AND (has_table_privilege(target,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(target,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
       OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','drizzle') AND c.relkind='S'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(target,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND has_function_privilege(target,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'Cutover role has preexisting application privileges';
    END IF;
  END LOOP;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I,%I',runtime_name,maintenance_name);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON rooms,rate_limits,room_resume_sessions,publication_subscribers,publication_deliveries,publication_snapshot_attempts TO %I',runtime_name);
  EXECUTE format('GRANT SELECT,INSERT ON messages,message_publication_pending,resume_message_receipts TO %I',runtime_name);
  EXECUTE format('GRANT SELECT,UPDATE(id) ON publication_admission TO %I',runtime_name);
  EXECUTE format('GRANT USAGE ON SEQUENCE messages_id_seq TO %I',runtime_name);
  EXECUTE format('GRANT SELECT,DELETE ON room_resume_sessions,resume_message_receipts,publication_deliveries,rate_limits TO %I',maintenance_name);
  EXECUTE format('GRANT UPDATE(id) ON room_resume_sessions TO %I',maintenance_name);
  EXECUTE format('GRANT UPDATE(client_message_id) ON resume_message_receipts TO %I',maintenance_name);
  EXECUTE format('GRANT UPDATE(message_id) ON publication_deliveries TO %I',maintenance_name);
  EXECUTE format('GRANT SELECT,UPDATE(session_id) ON publication_subscribers TO %I',maintenance_name);
END
$$;
COMMIT;
