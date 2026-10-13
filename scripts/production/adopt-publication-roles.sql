-- READ-ONLY existing-role adoption audit. Never GRANT, REVOKE, migrate or activate.
-- Requires independently checked whole-catalog fingerprint/owners/ACLs first.
-- Set dimle.cutover_runtime/maintenance on a real restricted owner connection.
-- Snapshot evidence ONLY: no persistent DDL fence, TLS or runtime startup proof.
-- FENCED mode is read-only too: caller retains the operator session lock and
-- temporarily uses SET SESSION AUTHORIZATION to the NOLOGIN restricted owner.
-- This mode never reopens a role and is NOT authorization to activate.
-- Foreign DB CONNECT and PUBLIC/inherited/column privileges are effective checks.
BEGIN READ ONLY;
-- No durable DDL fence is claimed; this audit does not authorize activation.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;
SELECT pg_catalog.pg_advisory_xact_lock(1145654604, 1);
DO $$
DECLARE
  runtime_name text := current_setting('dimle.cutover_runtime', true);
  maintenance_name text := current_setting('dimle.cutover_maintenance', true);
  audit_state text := COALESCE(NULLIF(current_setting('dimle.cutover_state', true), ''), 'LOGIN');
  target text;
  target_oid oid;
  obj record; privilege text; expected boolean; actual boolean; column_name text;
BEGIN
  IF audit_state NOT IN ('LOGIN','FENCED') THEN
    RAISE EXCEPTION 'Adoption state invalid';
  END IF;
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
  IF audit_state='FENCED' AND (
      NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
        AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=1145654604 AND objid=2 AND objsubid=2)
      OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user
        AND NOT rolcanlogin AND rolvaliduntil>clock_timestamp()
        AND rolvaliduntil<=clock_timestamp()+interval '24 hours')) THEN
    RAISE EXCEPTION 'Adoption fenced owner/session lock required';
  END IF;
  -- Exact release history, not a row-count proxy for compatibility. The shared
  -- advisory lock coordinates participating migration tools only.
  LOCK TABLE drizzle.__drizzle_migrations IN ACCESS SHARE MODE;
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
  FOREACH target IN ARRAY ARRAY[runtime_name,maintenance_name] LOOP
    SELECT oid INTO target_oid FROM pg_roles WHERE rolname=target
      AND rolcanlogin=(audit_state='LOGIN')
      AND rolvaliduntil > clock_timestamp()
      AND (audit_state<>'FENCED' OR rolvaliduntil<=clock_timestamp()+interval '24 hours')
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit);
    IF target_oid IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=target_oid OR roleid=target_oid)
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=target_oid)
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=target_oid)
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=target_oid)
      OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=target_oid)
      OR has_database_privilege(target,current_database(),'CREATE,TEMP')
      OR has_database_privilege(target,current_database(),'CONNECT WITH GRANT OPTION')
      OR NOT has_database_privilege(target,current_database(),'CONNECT')
      OR EXISTS(SELECT 1 FROM pg_database WHERE datallowconn AND datname<>current_database()
        AND has_database_privilege(target,oid,'CONNECT')) THEN
      RAISE EXCEPTION 'Adoption role isolation mismatch';
    END IF;
    FOR obj IN SELECT oid,nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' LOOP
      IF has_schema_privilege(target,obj.oid,'CREATE') OR has_schema_privilege(target,obj.oid,'USAGE WITH GRANT OPTION') OR
         has_schema_privilege(target,obj.oid,'USAGE') IS DISTINCT FROM (obj.nspname='public') THEN
        RAISE EXCEPTION 'Adoption schema privilege mismatch';
      END IF;
    END LOOP;
    FOR obj IN SELECT c.oid,c.relname,c.relkind,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S') LOOP
      IF obj.relkind='S' THEN
        FOREACH privilege IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
          expected := target=runtime_name AND obj.nspname='public' AND obj.relname='messages_id_seq' AND privilege='USAGE';
          IF has_sequence_privilege(target,obj.oid,privilege) IS DISTINCT FROM expected OR
             has_sequence_privilege(target,obj.oid,privilege||' WITH GRANT OPTION') THEN
            RAISE EXCEPTION 'Adoption sequence privilege mismatch';
          END IF;
        END LOOP;
      ELSE
        FOREACH privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] ||
            CASE WHEN current_setting('server_version_num')::int>=170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END LOOP
          expected := obj.nspname='public' AND CASE WHEN target=runtime_name THEN
            (obj.relname=ANY(ARRAY['rooms','rate_limits','room_resume_sessions','publication_subscribers','publication_deliveries','publication_snapshot_attempts']) AND privilege=ANY(ARRAY['SELECT','INSERT','UPDATE'])) OR
            (obj.relname=ANY(ARRAY['messages','message_publication_pending','resume_message_receipts']) AND privilege=ANY(ARRAY['SELECT','INSERT'])) OR
            (obj.relname='publication_admission' AND privilege='SELECT')
          ELSE
            (obj.relname=ANY(ARRAY['room_resume_sessions','resume_message_receipts','publication_deliveries','rate_limits']) AND privilege=ANY(ARRAY['SELECT','DELETE'])) OR
            (obj.relname='publication_subscribers' AND privilege='SELECT') END;
          actual := has_table_privilege(target,obj.oid,privilege);
          IF actual IS DISTINCT FROM expected OR has_table_privilege(target,obj.oid,privilege||' WITH GRANT OPTION') THEN
            RAISE EXCEPTION 'Adoption table privilege mismatch';
          END IF;
          IF privilege=ANY(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) THEN
            FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid=obj.oid AND attnum>0 AND NOT attisdropped LOOP
              actual := expected OR (obj.nspname='public' AND privilege='UPDATE' AND CASE WHEN target=runtime_name THEN
                obj.relname='publication_admission' AND column_name='id'
              ELSE (obj.relname='room_resume_sessions' AND column_name='id') OR
                (obj.relname='resume_message_receipts' AND column_name='client_message_id') OR
                (obj.relname='publication_deliveries' AND column_name='message_id') OR
                (obj.relname='publication_subscribers' AND column_name='session_id') END);
              IF has_column_privilege(target,obj.oid,column_name,privilege) IS DISTINCT FROM actual OR
                 has_column_privilege(target,obj.oid,column_name,privilege||' WITH GRANT OPTION') THEN
                RAISE EXCEPTION 'Adoption column privilege mismatch';
              END IF;
            END LOOP;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(target,p.oid,'EXECUTE'))
      OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE a.grantee IN (0,target_oid)) THEN
      RAISE EXCEPTION 'Adoption function or default privilege mismatch';
    END IF;
  END LOOP;
END
$$;
COMMIT;
