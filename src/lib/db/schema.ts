import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  jsonb,
  uuid,
  check,
  bigint,
  integer,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  authVersion: integer("auth_version").default(1).notNull(),
  passwordHash: text("password_hash"),
  creationTokenHash: text("creation_token_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    username: text("username").notNull(),
    type: text("type").notNull().default("message"),
    content: text("content").notNull(),
    clientMessageId: varchar("client_message_id", { length: 128 }),
    ts: timestamp("ts").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("messages_agent_idempotency_idx").on(
      table.roomId,
      table.username,
      table.clientMessageId
    ),
  ]
);

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 255 }).primaryKey(),
  points: integer("points").default(0).notNull(),
  expire: bigint("expire", { mode: "number" }),
});

export const roomResumeSessions = pgTable("room_resume_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  authVersion: integer("auth_version").notNull(),
  generation: integer("generation").default(0).notNull(),
  lastOperationId: text("last_operation_id"),
  lastTransportId: text("last_transport_id"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [index("resume_sessions_expiry_idx").on(table.expiresAt, table.id)]);

// Receipt survives message deletion (NULL is a tombstone), but not session deletion.
export const resumeMessageReceipts = pgTable("resume_message_receipts", {
  sessionId: text("session_id").notNull().references(() => roomResumeSessions.id, { onDelete: "cascade" }),
  clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  messageId: integer("message_id").references(() => messages.id, { onDelete: "set null" }),
}, table => [
  primaryKey({ columns: [table.sessionId, table.clientMessageId] }),
  index("resume_receipts_message_idx").on(table.messageId),
]);

// PRIVATE: absent budget row denies all uploads. Provision only after a real
// volume/headroom audit. No automatic seed, refund, cleanup or cascading delete.
export const resumeUploadBudget = pgTable("resume_upload_budget", {
  id: integer("id").primaryKey(),
  capacityBytes: bigint("capacity_bytes", { mode: "number" }).notNull(),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).default(0).notNull(),
}, t => [check("resume_upload_budget_bounds", sql`${t.id} = 1 AND ${t.capacityBytes} > 0 AND ${t.capacityBytes} <= 9007199254740991 AND ${t.reservedBytes} >= 0 AND ${t.reservedBytes} <= ${t.capacityBytes}`)]);

// Provenance intentionally survives session/room/receipt expiry and deletion.
export const resumeUploadAttempts = pgTable("resume_upload_attempts", {
  storageKey: varchar("storage_key", { length: 64 }).primaryKey(),
  sessionId: text("session_id").notNull(),
  roomId: text("room_id").notNull(),
  clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [check("resume_upload_attempt_bounds", sql`${t.reservedBytes} > 0 AND ${t.reservedBytes} <= 104857600 AND ${t.storageKey} ~ '^[0-9a-f]{64}$'`)]);

// PRIVATE accounting ledger: empty migration, no seed or public consumer.
// Provisioners lock the canonical domain; generation changes never reset liabilities.
const resourceKey = () => ({
  databaseIdentity: text("database_identity").notNull(),
  schemaIdentity: text("schema_identity").notNull(),
  quotaDomain: text("quota_domain").notNull(),
});
const policyKey = () => ({
  ...resourceKey(),
  namespace: text("namespace").notNull(),
  policyVersion: text("policy_version").notNull(),
  writerGeneration: text("writer_generation").notNull(),
});
const boundedText = (column: AnyPgColumn) => sql`length(${column}) BETWEEN 1 AND 512 AND ${column} = btrim(${column}) AND ${column} !~ '[[:cntrl:]]'`;
const safeBalance = (column: AnyPgColumn, min = 0) => sql`${column} BETWEEN ${sql.raw(String(min))} AND 9007199254740991`;
const allText = (columns: AnyPgColumn[]) => sql.join(columns.map(boundedText), sql` AND `);
// Structural SQL guard; the exact quote validator remains mandatory under lock.
// IS TRUE prevents SQL NULL / absent JSON keys from passing a CHECK.
const snapshotCheck = (t: { policySnapshot: AnyPgColumn; databaseIdentity: AnyPgColumn;
  schemaIdentity: AnyPgColumn; quotaDomain: AnyPgColumn; namespace: AnyPgColumn;
  policyVersion: AnyPgColumn; writerGeneration: AnyPgColumn }) => sql`(
  jsonb_typeof(${t.policySnapshot}) = 'object'
  AND ${t.policySnapshot} @> jsonb_build_object(
    'adapter', 'multer-crossing-byte-v1',
    'layout', 'provisioned-root-one-directory-one-file-v1',
    'allocationModel', 'audited-rounded-copies-v1',
    'stableExclusiveNamespace', true, 'allAllocationCostsBounded', true,
    'identity', jsonb_build_object('database', ${t.databaseIdentity},
      'schema', ${t.schemaIdentity}, 'quotaDomain', ${t.quotaDomain},
      'namespace', ${t.namespace}, 'policyVersion', ${t.policyVersion},
      'writerGeneration', ${t.writerGeneration}))
  AND ${t.policySnapshot} ?& ARRAY['maxFileBytes','allocationUnitBytes','allocationCopies',
    'directoryAndParentBytes','metadataBytes','temporaryBytes','additionalObjects']
  AND ${sql.join(["maxFileBytes", "allocationUnitBytes", "allocationCopies",
    "directoryAndParentBytes", "metadataBytes", "temporaryBytes", "additionalObjects"].map(key =>
      sql`CASE WHEN jsonb_typeof(${t.policySnapshot}->${sql.raw("'" + key + "'")}) = 'number'
        THEN (${t.policySnapshot}->>${sql.raw("'" + key + "'")})::numeric BETWEEN ${sql.raw(key === "allocationUnitBytes" || key === "allocationCopies" ? "1" : "0")} AND 9007199254740991
          AND trunc((${t.policySnapshot}->>${sql.raw("'" + key + "'")})::numeric) = (${t.policySnapshot}->>${sql.raw("'" + key + "'")})::numeric
        ELSE false END`), sql` AND `)}
) IS TRUE`;

export const uploadResourceDomains = pgTable("upload_resource_domains", {
  ...resourceKey(),
  writerGeneration: text("writer_generation").notNull(),
  active: boolean("active").notNull(),
  auditId: text("audit_id").notNull(),
  capacityBytes: bigint("capacity_bytes", { mode: "bigint" }).notNull(),
  headroomBytes: bigint("headroom_bytes", { mode: "bigint" }).notNull(),
  baselineBytes: bigint("baseline_bytes", { mode: "bigint" }).notNull(),
  outstandingBytes: bigint("outstanding_bytes", { mode: "bigint" }).notNull(),
  capacityObjects: bigint("capacity_objects", { mode: "bigint" }).notNull(),
  headroomObjects: bigint("headroom_objects", { mode: "bigint" }).notNull(),
  baselineObjects: bigint("baseline_objects", { mode: "bigint" }).notNull(),
  outstandingObjects: bigint("outstanding_objects", { mode: "bigint" }).notNull(),
}, t => [
  primaryKey({ name: "resource_domain_pk", columns: [t.databaseIdentity, t.schemaIdentity, t.quotaDomain] }),
  check("resource_domain_identity", allText([t.databaseIdentity, t.schemaIdentity, t.quotaDomain, t.writerGeneration, t.auditId])),
  check("resource_domain_bytes", sql`${safeBalance(t.capacityBytes, 1)} AND ${safeBalance(t.headroomBytes)} AND ${safeBalance(t.baselineBytes)} AND ${safeBalance(t.outstandingBytes)}
    AND ${t.headroomBytes} + ${t.baselineBytes} + ${t.outstandingBytes} <= ${t.capacityBytes}`),
  check("resource_domain_objects", sql`${safeBalance(t.capacityObjects, 1)} AND ${safeBalance(t.headroomObjects)} AND ${safeBalance(t.baselineObjects)} AND ${safeBalance(t.outstandingObjects)}
    AND ${t.headroomObjects} + ${t.baselineObjects} + ${t.outstandingObjects} <= ${t.capacityObjects}`),
]);

export const uploadResourcePolicies = pgTable("upload_resource_policies", {
  ...policyKey(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
}, t => [
  primaryKey({ name: "resource_policy_pk", columns: [t.databaseIdentity, t.schemaIdentity, t.quotaDomain, t.namespace, t.policyVersion, t.writerGeneration] }),
  foreignKey({ name: "resource_policy_domain_fk",
    columns: [t.databaseIdentity, t.schemaIdentity, t.quotaDomain],
    foreignColumns: [uploadResourceDomains.databaseIdentity, uploadResourceDomains.schemaIdentity, uploadResourceDomains.quotaDomain],
  }).onDelete("restrict").onUpdate("restrict"),
  check("resource_policy_identity", allText([t.databaseIdentity, t.schemaIdentity, t.quotaDomain, t.namespace, t.policyVersion, t.writerGeneration])),
  check("resource_policy_snapshot", snapshotCheck(t)),
]);

export const uploadResourceAttempts = pgTable("upload_resource_attempts", {
  attemptId: uuid("attempt_id").primaryKey(),
  ...policyKey(),
  auditId: text("audit_id").notNull(),
  operationId: text("operation_id").notNull(),
  writerId: text("writer_id").notNull(),
  allocatedBytes: bigint("allocated_bytes", { mode: "bigint" }).notNull(),
  objects: bigint("objects", { mode: "bigint" }).notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("resource_attempt_operation_idx").on(t.databaseIdentity, t.schemaIdentity, t.quotaDomain, t.operationId),
  foreignKey({ name: "resource_attempt_policy_fk",
    columns: [t.databaseIdentity, t.schemaIdentity, t.quotaDomain, t.namespace, t.policyVersion, t.writerGeneration],
    foreignColumns: [uploadResourcePolicies.databaseIdentity, uploadResourcePolicies.schemaIdentity,
      uploadResourcePolicies.quotaDomain, uploadResourcePolicies.namespace,
      uploadResourcePolicies.policyVersion, uploadResourcePolicies.writerGeneration],
  }).onDelete("restrict").onUpdate("restrict"),
  check("resource_attempt_identity", allText([t.databaseIdentity, t.schemaIdentity, t.quotaDomain,
    t.namespace, t.policyVersion, t.writerGeneration, t.auditId, t.operationId, t.writerId])),
  check("resource_attempt_charge", sql`${safeBalance(t.allocatedBytes, 1)} AND ${safeBalance(t.objects, 1)}`),
  check("resource_attempt_snapshot", snapshotCheck(t)),
]);
