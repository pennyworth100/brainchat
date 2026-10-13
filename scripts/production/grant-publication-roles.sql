-- OFFLINE owner-only grants. No role creation, budget allocation or activation.
-- Same authenticated session must set dimle.cutover_runtime and
-- dimle.cutover_maintenance (role names, not credentials).
BEGIN;
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
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 11 THEN
    RAISE EXCEPTION 'Eleven base migrations required';
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
