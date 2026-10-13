/**
 * Operator-only acquisition primitive; NEVER imported by server startup.
 * Caller owns a dedicated authenticated Client, verified TLS/target manifest,
 * and exclusive operator control. Keep that same session alive through audits.
 * NOLOGIN is durable; exceptions/disconnect NEVER reopen it. This primitive
 * does not authorize activation or claim protection against trusted admins.
 */
import {auditCatalogReader} from "./audit-catalog-reader.mjs";
export async function acquireWriterFence(client, manifest) {
  const { database, systemIdentifier, operator, owner, runtime, maintenance, reader } = structuredClone(manifest);
  const roles = [owner, runtime, maintenance];
  const principals = reader ? [...roles,reader] : roles;
  if (!database || !systemIdentifier || !operator || roles.some(r =>
      !r || !/^[a-z_][a-z0-9_]{0,62}$/.test(r.name) || !Number.isSafeInteger(r.oid) || r.oid <= 0) ||
      new Set(roles.map(r => r.name)).size !== 3 || new Set(roles.map(r => r.oid)).size !== 3 ||
      roles.some(r => r.name === operator)) throw Error("Invalid fence manifest");
  if (reader && (!/^[a-z_][a-z0-9_]{0,62}$/.test(reader.name) ||
      !Number.isSafeInteger(reader.oid) || reader.oid<=0 || reader.name===operator ||
      new Set(principals.map(r=>r.name)).size!==4 || new Set(principals.map(r=>r.oid)).size!==4))
    throw Error("Invalid catalog reader manifest");
  const names = roles.map(r => r.name);
  const allowedNames = principals.map(r=>r.name);
  // Session-scoped: another participating operator must not interleave.
  const lock = await client.query("SELECT pg_try_advisory_lock(1145654604, 2) AS acquired");
  if (lock.rows[0]?.acquired !== true) throw Error("Fence operator busy");
  const backend = (await client.query(`SELECT pg_backend_pid() AS pid,
    backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
  if (!backend?.pid || !backend.backend_start) throw Error("Fence backend identity unavailable");
  async function identity() {
    const result = await client.query(`SELECT current_database() AS database,current_user,session_user,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS operator,
      (SELECT datdba::int FROM pg_database WHERE datname=current_database()) AS owner`);
    const r = result.rows[0];
    if (r.database !== database || r.system !== systemIdentifier || r.current_user !== operator ||
        r.session_user !== operator || !r.operator || r.owner !== owner.oid)
      throw Error("Fence target/operator mismatch");
    const actual = (await client.query(`SELECT oid::int,rolname,rolsuper,rolcreatedb,rolcreaterole,
      rolreplication,rolbypassrls,rolinherit,rolvaliduntil > clock_timestamp()
      AND rolvaliduntil <= clock_timestamp() + interval '24 hours' AS fresh
      FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])).rows;
    if (actual.length !== 3 || actual.some(a => !roles.some(r => r.name === a.rolname && r.oid === a.oid) ||
        a.rolsuper || a.rolcreatedb || a.rolcreaterole || a.rolreplication || a.rolbypassrls ||
        a.rolinherit || a.fresh !== true)) throw Error("Fence principal mismatch");
    if ((await client.query("SELECT 1 FROM pg_auth_members WHERE member=ANY($1::oid[]) OR roleid=ANY($1::oid[])", [roles.map(r=>r.oid)])).rowCount)
      throw Error("Fence membership bypass");
    // NOLOGIN is cluster-wide: never affect a role shared with another DB.
    if ((await client.query(`SELECT 1 FROM pg_roles r CROSS JOIN pg_database d
      WHERE r.rolname=ANY($1::text[]) AND d.datname<>current_database()
      AND (d.datdba=r.oid OR (d.datallowconn AND has_database_privilege(r.oid,d.oid,'CONNECT')))`, [names])).rowCount ||
        (await client.query(`SELECT 1 FROM pg_stat_activity WHERE usename=ANY($1::text[])
          AND datname IS DISTINCT FROM current_database()`, [names])).rowCount)
      throw Error("Fence principal has foreign database authority");
    if ((await client.query(`SELECT 1 FROM pg_roles WHERE rolcanlogin AND rolname<>$1
      AND NOT(rolname=ANY($2::text[])) AND has_database_privilege(oid,current_database(),'CONNECT')`,
      [operator,allowedNames])).rowCount) throw Error("Uninventoried login authority");
    if (reader) await auditCatalogReader(client,reader);
  }
  async function background() {
    if ((await client.query("SELECT 1 FROM pg_prepared_xacts WHERE database=current_database()")).rowCount ||
        (await client.query("SELECT 1 FROM pg_replication_slots WHERE database=current_database()")).rowCount ||
        (await client.query("SELECT 1 FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database())")).rowCount ||
        (await client.query("SELECT 1 FROM pg_extension WHERE extname<>'plpgsql'")).rowCount)
      throw Error("Prepared/background writer blocks fence");
  }
  await identity();
  await background(); // reject known blockers BEFORE changing login flags
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    for (const role of roles) await client.query('ALTER ROLE "' + role.name + '" NOLOGIN');
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  // Anything below may fail, but the committed NOLOGIN fence stays closed.
  const sessions = (await client.query(`SELECT pid,backend_start::text,usename,backend_type
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
  for (const s of sessions) {
    if (reader && s.usename===reader.name && s.backend_type==="client backend") continue;
    if (!names.includes(s.usename) || s.backend_type !== "client backend")
      throw Error("Uninventoried active backend; logins remain fenced");
    const stopped = await client.query(`SELECT pg_terminate_backend(pid,1000) AS stopped
      FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND usename=$3
      AND datname=current_database()`, [s.pid,s.backend_start,s.usename]);
    if (stopped.rowCount && stopped.rows[0].stopped !== true) throw Error("Writer drain failed");
  }
  // A receipt is not a transferable activation token. Fresh checks must use
  // this exact dedicated backend, never silently acquire a replacement lock.
  // Any observed failure permanently poisons this handle. Trusted callers must
  // not release/reacquire locks or multiplex this client between assertions.
  let invalid = false, checking = false;
  const invalidate = () => { invalid = true; };
  client.once("error", invalidate);
  client.once("end", invalidate);
  async function assertHeld() {
    if (invalid || checking) { invalid = true; throw Error("Fence handle invalid"); }
    checking = true;
    try {
      const current = (await client.query(`SELECT pg_backend_pid() AS pid,
        backend_start::text, EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND classid=1145654604 AND objid=2 AND objsubid=2) AS held
        FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
      if (current?.pid !== backend.pid || current.backend_start !== backend.backend_start || current.held !== true)
        throw Error("Fence original backend/session lock lost");
      await identity();
      await background();
      if ((await client.query("SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[]) AND rolcanlogin", [names])).rowCount ||
          (await client.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND (usename IS DISTINCT FROM $1 OR backend_type<>$2)", [reader?.name ?? null,"client backend"])).rowCount)
        throw Error("Fence verification failed");
      if (invalid) throw Error("Fence handle invalid");
    } catch (error) {
      invalid = true;
      throw error;
    } finally { checking = false; }
  }
  await assertHeld();
  return Object.freeze({state:"FENCED",database,systemIdentifier,roles:roles.map(r=>({...r})),
    reader:reader ? Object.freeze({...reader}) : null,
    drained:sessions.filter(s=>s.usename!==reader?.name).length,
    backend:Object.freeze({...backend}),assertHeld,activationAuthorized:false});
}
