import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Socket } from "socket.io";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeOperationGate } from "./resume-operation";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeSocketOwner } from "./resume-socket";
import { ResumeCapacity } from "./resume-capacity";

type Row = { id: number; type: string; username: string; content: string; ts: Date };
export type PublicationBatch = { deliveryTry: string; roomId: string; sessionId: string;
  generation: number; messages: Row[] };
export type PublicationSnapshot = PublicationBatch & { cut: "full-bounded-statement" };
const BATCH = 16, TOTAL = 256, BYTES = 1024 * 1024;

// PRIVATE bounded proof. No public handler/startup migration. Retained ACK set,
// not MAX(id): IDs identify messages, never their commit order. Expiry/capacity
// fail closed; no eviction or global journal deletion. Caller owns poll cadence.
export class ResumePublication {
  constructor(private readonly gate: ResumeOperationGate) {}
  private async register(tx: Pick<PoolClient, "query">, binding: ResumeBinding) {
    let subscriber = await tx.query("SELECT session_id FROM publication_subscribers WHERE session_id=$1 AND expires_at>clock_timestamp()", [binding.sessionId]);
    if (!subscriber.rowCount) {
      await tx.query("SELECT id FROM publication_admission WHERE id=1 FOR UPDATE");
      const count = await tx.query("SELECT count(*)::int AS n FROM publication_subscribers");
      if (count.rows[0].n >= 100) throw Error("Publication subscriber capacity");
      await tx.query(`INSERT INTO publication_subscribers(session_id,expires_at)
        VALUES ($1,to_timestamp($2/1000.0)) ON CONFLICT DO NOTHING`, [binding.sessionId, binding.expiresAt]);
      subscriber = await tx.query("SELECT session_id FROM publication_subscribers WHERE session_id=$1 AND expires_at>clock_timestamp()", [binding.sessionId]);
      if (!subscriber.rowCount) throw Error("Publication subscription expired");
    }
  }

  // Full room cut from ONE SQL statement, not newest100 + a second pending read.
  // The durable journal retains every later commit, including a lower ID. This
  // private primitive does NOT assert browser READY or drain an existing lease.
  // No truncation: an oversized room fails closed, rolling back registration.
  async snapshot(binding: ResumeBinding): Promise<PublicationSnapshot | null> {
    const result = await this.gate.run(binding, async tx => {
      await this.register(tx, binding);
      const captured = await tx.query<Row & { journaled: boolean }>(`SELECT m.id,m.type,m.username,m.content,m.ts,
        (p.message_id IS NOT NULL) AS journaled FROM messages m
        LEFT JOIN message_publication_pending p ON p.message_id=m.id AND p.room_id=m.room_id
        WHERE m.room_id=$1 ORDER BY m.id LIMIT $2`, [binding.roomId, TOTAL + 1]);
      if (captured.rows.length > TOTAL) throw Error("Publication snapshot capacity");
      if (captured.rows.some(row => !row.journaled)) throw Error("Publication snapshot journal gap");
      const messages = captured.rows.map(({ journaled: _journaled, ...row }) => row);
      if (Buffer.byteLength(JSON.stringify(messages)) > BYTES) throw Error("Publication snapshot byte capacity");
      const ids = messages.map(row => row.id);
      const size = await tx.query(`SELECT count(*)::int AS n FROM
        (SELECT message_id FROM publication_deliveries WHERE session_id=$1
         UNION SELECT unnest($2::integer[])) entries`, [binding.sessionId, ids]);
      if (size.rows[0].n > TOTAL) throw Error("Publication receipt capacity");
      const deliveryTry = randomUUID();
      // A new full snapshot needs its OWN client ACK, including rows ACKed by a
      // previous physical browser. Supersede old attempts; do not auto-ACK emit.
      await tx.query(`INSERT INTO publication_deliveries
        (session_id,message_id,generation,transport_id,delivery_try,lease_until)
        SELECT $1,id,$3,$4,$5,clock_timestamp()+interval '5 seconds' FROM unnest($2::integer[]) id
        ON CONFLICT(session_id,message_id) DO UPDATE SET generation=EXCLUDED.generation,
        transport_id=EXCLUDED.transport_id,delivery_try=EXCLUDED.delivery_try,
        lease_until=EXCLUDED.lease_until,acked=false`,
        [binding.sessionId,ids,binding.generation,binding.transportId,deliveryTry]);
      // A cut is a durable SET, even when empty. Row receipts alone cannot prove
      // completion of an empty cut, or the identity of the entire captured set.
      await tx.query(`INSERT INTO publication_snapshot_attempts
        (session_id,generation,transport_id,delivery_try,message_ids,lease_until)
        VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '5 seconds')
        ON CONFLICT(session_id) DO UPDATE SET generation=EXCLUDED.generation,
        transport_id=EXCLUDED.transport_id,delivery_try=EXCLUDED.delivery_try,
        message_ids=EXCLUDED.message_ids,lease_until=EXCLUDED.lease_until,acked=false`,
        [binding.sessionId,binding.generation,binding.transportId,deliveryTry,ids]);
      return { cut: "full-bounded-statement" as const, deliveryTry, roomId: binding.roomId,
        sessionId: binding.sessionId, generation: binding.generation, messages };
    });
    return result.authorized ? result.value : null;
  }

  async claim(binding: ResumeBinding): Promise<PublicationBatch | null> {
    const result = await this.gate.run(binding, async tx => {
      // Gate already locks room/session and authenticates durable generation,
      // physical incarnation and policy. One subscriber per logical session.
      await this.register(tx, binding);
      // One bounded snapshot of the unACKed set. Concurrent later commits are
      // still in the durable journal and appear on the next reconciliation.
      const candidates = await tx.query<{id:number;bytes:number}>(`SELECT p.message_id AS id,
          octet_length(m.content)+octet_length(m.username)+128 AS bytes
        FROM message_publication_pending p JOIN messages m ON m.id=p.message_id
        LEFT JOIN publication_deliveries d ON d.session_id=$1 AND d.message_id=p.message_id
        WHERE p.room_id=$2 AND m.room_id=$2 AND (d.message_id IS NULL OR
          (NOT d.acked AND (d.lease_until<=clock_timestamp() OR d.generation<>$3 OR d.transport_id<>$4)))
        ORDER BY p.message_id LIMIT $5`,
        [binding.sessionId,binding.roomId,binding.generation,binding.transportId,BATCH]);
      const ids = candidates.rows.map(r=>r.id);
      if (candidates.rows.reduce((n,r)=>n+r.bytes,0)>BYTES) throw Error("Publication byte capacity");
      const size = await tx.query(`SELECT count(*)::int AS n FROM
        (SELECT message_id FROM publication_deliveries WHERE session_id=$1
         UNION SELECT unnest($2::integer[])) entries`, [binding.sessionId,ids]);
      if (size.rows[0].n>TOTAL) throw Error("Publication receipt capacity");
      const deliveryTry = randomUUID();
      await tx.query(`INSERT INTO publication_deliveries
        (session_id,message_id,generation,transport_id,delivery_try,lease_until)
        SELECT $1,id,$3,$4,$5,clock_timestamp()+interval '5 seconds' FROM unnest($2::integer[]) id
        ON CONFLICT(session_id,message_id) DO UPDATE SET generation=EXCLUDED.generation,
        transport_id=EXCLUDED.transport_id,delivery_try=EXCLUDED.delivery_try,lease_until=EXCLUDED.lease_until`,
        [binding.sessionId,ids,binding.generation,binding.transportId,deliveryTry]);
      const rows = await tx.query<Row>("SELECT id,type,username,content,ts FROM messages WHERE room_id=$1 AND id=ANY($2::integer[]) ORDER BY id",[binding.roomId,ids]);
      // UPDATE/DELETE are unsupported until tombstone semantics are designed.
      if (rows.rowCount!==ids.length || Buffer.byteLength(JSON.stringify(rows.rows))>BYTES)
        throw Error("Publication changed during claim");
      return {deliveryTry,roomId:binding.roomId,sessionId:binding.sessionId,
        generation:binding.generation,messages:rows.rows};
    });
    return result.authorized ? result.value : null;
  }

  // PRIVATE persistence primitive, NOT browser READY. The caller still owns the
  // exact physical request, confirmation transport and continuing reconciliation.
  // Retry is idempotent only for this same retained, unexpired cut attempt.
  async acknowledgeSnapshot(binding: ResumeBinding, batch: PublicationSnapshot, reply: unknown): Promise<boolean> {
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) return false;
    const ack = reply as { deliveryTry?: unknown; ids?: unknown };
    const ids = batch.messages.map(row => row.id);
    const deliveryTry = batch.deliveryTry; // capture before any gate/lock await
    if (batch.cut !== "full-bounded-statement" || batch.roomId !== binding.roomId ||
        batch.sessionId !== binding.sessionId || batch.generation !== binding.generation ||
        ack.deliveryTry !== deliveryTry || !Array.isArray(ack.ids) ||
        ack.ids.length !== ids.length || !ack.ids.every((id, i) => id === ids[i])) return false;
    const result = await this.gate.run(binding, async tx => {
      // Compare against the durable set, not a caller-supplied subset. Mark and
      // row settlement are one transaction; mismatch rolls everything back.
      const attempt = await tx.query(`UPDATE publication_snapshot_attempts a SET acked=true
        FROM publication_subscribers s WHERE a.session_id=s.session_id
        AND s.expires_at>clock_timestamp() AND a.session_id=$1 AND a.generation=$2
        AND a.transport_id=$3 AND a.delivery_try=$4 AND a.message_ids=$5::integer[]
        AND a.lease_until>clock_timestamp() RETURNING a.session_id`,
        [binding.sessionId,binding.generation,binding.transportId,deliveryTry,ids]);
      if (attempt.rowCount !== 1) throw Error("Publication snapshot ACK lease lost");
      const rows = await tx.query(`UPDATE publication_deliveries SET acked=true
        WHERE session_id=$1 AND message_id=ANY($2::integer[]) AND generation=$3
        AND transport_id=$4 AND delivery_try=$5 AND lease_until>clock_timestamp()
        RETURNING message_id`, [binding.sessionId,ids,binding.generation,binding.transportId,deliveryTry]);
      if (rows.rowCount !== ids.length) throw Error("Publication snapshot ACK receipt lost");
      return true;
    });
    return result.authorized && result.value;
  }

  async acknowledge(binding: ResumeBinding, batch: PublicationBatch, reply: unknown): Promise<boolean> {
    if (!reply || typeof reply!=="object") return false;
    const ack = reply as {deliveryTry?:unknown;ids?:unknown};
    const ids = batch.messages.map(r=>r.id);
    if (batch.roomId!==binding.roomId || batch.sessionId!==binding.sessionId ||
        batch.generation!==binding.generation || ack.deliveryTry!==batch.deliveryTry ||
        !Array.isArray(ack.ids) || ack.ids.length!==ids.length || !ids.length ||
        !ack.ids.every((id,i)=>id===ids[i])) return false;
    const result = await this.gate.run(binding, async tx => {
      const rows = await tx.query(`UPDATE publication_deliveries d SET acked=true
        FROM publication_subscribers s WHERE d.session_id=s.session_id AND s.expires_at>clock_timestamp()
        AND d.session_id=$1 AND d.message_id=ANY($2::integer[]) AND d.generation=$3
        AND d.transport_id=$4 AND d.delivery_try=$5 AND d.lease_until>clock_timestamp()
        RETURNING d.message_id`,[binding.sessionId,ids,binding.generation,binding.transportId,batch.deliveryTry]);
      if (rows.rowCount!==ids.length) throw Error("Publication ACK lease lost");
      return true;
    });
    return result.authorized && result.value;
  }
}

const busy = new WeakSet<Socket>();
const capacity = new ResumeCapacity(32);
// Real Socket.IO client ACK, NOT emit success. The DB transaction settles before
// network IO; after await, exact physical membership AND DB policy revalidate.
export async function reconcilePublication(socket: Socket, owner: ResumeSocketOwner,
  members: ResumeMemberships, store: ResumePublication): Promise<boolean> {
  const binding = members.currentBindingFor(socket,owner);
  if (!binding || busy.has(socket)) return false;
  const release = capacity.acquire();
  if (!release) return false;
  const current = () => members.currentBindingFor(socket,owner)===binding;
  busy.add(socket);
  try {
    const batch = await store.claim(binding);
    if (!batch || !current()) return false;
    if (!batch.messages.length) return true;
    let reply: unknown;
    try { reply = await socket.timeout(4000).emitWithAck("publication-batch",batch); }
    catch { return false; } // lost ACK keeps receipts pending for lease retry
    if (!current()) return false;
    return await store.acknowledge(binding,batch,reply) && current();
  } finally { busy.delete(socket); release(); }
}
