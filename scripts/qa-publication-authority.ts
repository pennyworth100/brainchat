import assert from "node:assert/strict";
import { Pool } from "pg";

// Disposable loopback database only; all probes roll back, including DDL/roles.
const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, process.env.OWNED_PG_PORT);
assert.equal(url.search, "");
const db = new Pool({ connectionString: url.toString() });
let checks = 0;
const check = (value: unknown) => { assert.ok(value); checks++; };
async function main() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // A caller-controlled temp relation must never intercept the trigger write.
    await client.query("CREATE TEMP TABLE message_publication_pending (message_id integer, room_id text)");
    await client.query("SET LOCAL search_path = pg_temp, public");
    const shadow = (await client.query("INSERT INTO public.messages(room_id,username,content) VALUES ('publication','authority','temp shadow probe') RETURNING id")).rows[0].id;
    check((await client.query("SELECT 1 FROM public.message_publication_pending WHERE message_id=$1", [shadow])).rowCount === 1);
    check((await client.query("SELECT 1 FROM pg_temp.message_publication_pending")).rowCount === 0);
    const fn = (await client.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.enqueue_message_publication()'::regprocedure")).rows[0];
    check(fn.prosecdef === false);
    check(fn.proconfig.includes("search_path=pg_catalog, pg_temp"));
    await client.query("CREATE ROLE publication_fixture_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
    await client.query("GRANT USAGE ON SCHEMA public TO publication_fixture_writer");
    await client.query("GRANT INSERT ON public.messages TO publication_fixture_writer");
    await client.query("GRANT SELECT(id) ON public.messages TO publication_fixture_writer");
    await client.query("GRANT USAGE ON SEQUENCE public.messages_id_seq TO publication_fixture_writer");
    await client.query("SET LOCAL ROLE publication_fixture_writer");
    await client.query("SAVEPOINT missing_enqueue_grant");
    await assert.rejects(client.query("INSERT INTO public.messages(room_id,username,content) VALUES ('publication','authority','missing grant must rollback')"), e => (e as {code:string}).code === "42501"); checks++;
    await client.query("ROLLBACK TO SAVEPOINT missing_enqueue_grant");
    await client.query("RESET ROLE");
    check((await client.query("SELECT 1 FROM public.messages WHERE content='missing grant must rollback'")).rowCount === 0);
    await client.query("GRANT INSERT ON public.message_publication_pending TO publication_fixture_writer");
    await client.query("SET LOCAL ROLE publication_fixture_writer");
    const granted = (await client.query("INSERT INTO public.messages(room_id,username,content) VALUES ('publication','authority','least privilege enqueue') RETURNING id")).rows[0].id;
    await client.query("RESET ROLE");
    check((await client.query("SELECT 1 FROM public.message_publication_pending WHERE message_id=$1", [granted])).rowCount === 1);
    check(!(await client.query("SELECT has_table_privilege('publication_fixture_writer','public.message_publication_pending','UPDATE') AS allowed")).rows[0].allowed);
    check(!(await client.query("SELECT has_table_privilege('publication_fixture_writer','public.message_publication_pending','DELETE') AS allowed")).rows[0].allowed);
    console.log(JSON.stringify({status:"PASS", checks, scope:"private trigger search_path and invoker grants; NOT deployed role policy"}));
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await db.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
