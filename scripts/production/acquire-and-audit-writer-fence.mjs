/** Operator-only composition. Caller retains this dedicated session afterwards.
 * No activation, grants, migrations, capacity changes, or automatic reopening.
 * Transport and independent catalog/owner/ACL evidence remain caller gates.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {acquireWriterFence} from './acquire-writer-fence.mjs';

export async function acquireAndAuditWriterFence(client, manifest) {
  const pinned = structuredClone(manifest);
  const sql = await readFile(new URL('./adopt-publication-roles.sql', import.meta.url), 'utf8');
  const fence = await acquireWriterFence(client, pinned);
  // acquireWriterFence validates names before any interpolation. Authentication
  // remains the same dedicated superuser connection: RESET restores it, never
  // an owner LOGIN or a second connection that would lose the session lock.
  try {
    await client.query('SET SESSION AUTHORIZATION "' + pinned.owner.name + '"');
    await client.query("SELECT set_config('dimle.cutover_runtime',$1,false),set_config('dimle.cutover_maintenance',$2,false),set_config('dimle.cutover_state','FENCED',false)",
      [pinned.runtime.name,pinned.maintenance.name]);
    await client.query(sql);
  } finally {
    // Failed DO leaves an aborted read-only transaction; rollback first.
    // A reset failure is surfaced; caller must discard this connection.
    await client.query('ROLLBACK');
    await client.query('RESET SESSION AUTHORIZATION');
    await client.query("RESET dimle.cutover_runtime; RESET dimle.cutover_maintenance; RESET dimle.cutover_state");
  }
  return Object.freeze({...fence, adoption:'PASS',
    adoptionSQLSHA256:createHash('sha256').update(sql).digest('hex'), activationAuthorized:false});
}
