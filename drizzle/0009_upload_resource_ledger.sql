CREATE TABLE "upload_resource_attempts" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"database_identity" text NOT NULL,
	"schema_identity" text NOT NULL,
	"quota_domain" text NOT NULL,
	"namespace" text NOT NULL,
	"policy_version" text NOT NULL,
	"writer_generation" text NOT NULL,
	"audit_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"writer_id" text NOT NULL,
	"allocated_bytes" bigint NOT NULL,
	"objects" bigint NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_attempt_identity" CHECK (length("upload_resource_attempts"."database_identity") BETWEEN 1 AND 512 AND "upload_resource_attempts"."database_identity" = btrim("upload_resource_attempts"."database_identity") AND "upload_resource_attempts"."database_identity" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."schema_identity") BETWEEN 1 AND 512 AND "upload_resource_attempts"."schema_identity" = btrim("upload_resource_attempts"."schema_identity") AND "upload_resource_attempts"."schema_identity" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."quota_domain") BETWEEN 1 AND 512 AND "upload_resource_attempts"."quota_domain" = btrim("upload_resource_attempts"."quota_domain") AND "upload_resource_attempts"."quota_domain" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."namespace") BETWEEN 1 AND 512 AND "upload_resource_attempts"."namespace" = btrim("upload_resource_attempts"."namespace") AND "upload_resource_attempts"."namespace" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."policy_version") BETWEEN 1 AND 512 AND "upload_resource_attempts"."policy_version" = btrim("upload_resource_attempts"."policy_version") AND "upload_resource_attempts"."policy_version" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."writer_generation") BETWEEN 1 AND 512 AND "upload_resource_attempts"."writer_generation" = btrim("upload_resource_attempts"."writer_generation") AND "upload_resource_attempts"."writer_generation" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."audit_id") BETWEEN 1 AND 512 AND "upload_resource_attempts"."audit_id" = btrim("upload_resource_attempts"."audit_id") AND "upload_resource_attempts"."audit_id" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."operation_id") BETWEEN 1 AND 512 AND "upload_resource_attempts"."operation_id" = btrim("upload_resource_attempts"."operation_id") AND "upload_resource_attempts"."operation_id" !~ '[[:cntrl:]]' AND length("upload_resource_attempts"."writer_id") BETWEEN 1 AND 512 AND "upload_resource_attempts"."writer_id" = btrim("upload_resource_attempts"."writer_id") AND "upload_resource_attempts"."writer_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "resource_attempt_charge" CHECK ("upload_resource_attempts"."allocated_bytes" BETWEEN 1 AND 9007199254740991 AND "upload_resource_attempts"."objects" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "resource_attempt_snapshot" CHECK ((
  jsonb_typeof("upload_resource_attempts"."policy_snapshot") = 'object'
  AND "upload_resource_attempts"."policy_snapshot" @> jsonb_build_object(
    'adapter', 'multer-crossing-byte-v1',
    'layout', 'provisioned-root-one-directory-one-file-v1',
    'allocationModel', 'audited-rounded-copies-v1',
    'stableExclusiveNamespace', true, 'allAllocationCostsBounded', true,
    'identity', jsonb_build_object('database', "upload_resource_attempts"."database_identity",
      'schema', "upload_resource_attempts"."schema_identity", 'quotaDomain', "upload_resource_attempts"."quota_domain",
      'namespace', "upload_resource_attempts"."namespace", 'policyVersion', "upload_resource_attempts"."policy_version",
      'writerGeneration', "upload_resource_attempts"."writer_generation"))
  AND "upload_resource_attempts"."policy_snapshot" ?& ARRAY['maxFileBytes','allocationUnitBytes','allocationCopies',
    'directoryAndParentBytes','metadataBytes','temporaryBytes','additionalObjects']
  AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'maxFileBytes') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'maxFileBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'maxFileBytes')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'maxFileBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'allocationUnitBytes') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'allocationUnitBytes')::numeric BETWEEN 1 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'allocationUnitBytes')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'allocationUnitBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'allocationCopies') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'allocationCopies')::numeric BETWEEN 1 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'allocationCopies')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'allocationCopies')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'directoryAndParentBytes') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'directoryAndParentBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'directoryAndParentBytes')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'directoryAndParentBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'metadataBytes') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'metadataBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'metadataBytes')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'metadataBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'temporaryBytes') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'temporaryBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'temporaryBytes')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'temporaryBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_attempts"."policy_snapshot"->'additionalObjects') = 'number'
        THEN ("upload_resource_attempts"."policy_snapshot"->>'additionalObjects')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_attempts"."policy_snapshot"->>'additionalObjects')::numeric) = ("upload_resource_attempts"."policy_snapshot"->>'additionalObjects')::numeric
        ELSE false END
) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "upload_resource_domains" (
	"database_identity" text NOT NULL,
	"schema_identity" text NOT NULL,
	"quota_domain" text NOT NULL,
	"writer_generation" text NOT NULL,
	"active" boolean NOT NULL,
	"audit_id" text NOT NULL,
	"capacity_bytes" bigint NOT NULL,
	"headroom_bytes" bigint NOT NULL,
	"baseline_bytes" bigint NOT NULL,
	"outstanding_bytes" bigint NOT NULL,
	"capacity_objects" bigint NOT NULL,
	"headroom_objects" bigint NOT NULL,
	"baseline_objects" bigint NOT NULL,
	"outstanding_objects" bigint NOT NULL,
	CONSTRAINT "resource_domain_pk" PRIMARY KEY("database_identity","schema_identity","quota_domain"),
	CONSTRAINT "resource_domain_identity" CHECK (length("upload_resource_domains"."database_identity") BETWEEN 1 AND 512 AND "upload_resource_domains"."database_identity" = btrim("upload_resource_domains"."database_identity") AND "upload_resource_domains"."database_identity" !~ '[[:cntrl:]]' AND length("upload_resource_domains"."schema_identity") BETWEEN 1 AND 512 AND "upload_resource_domains"."schema_identity" = btrim("upload_resource_domains"."schema_identity") AND "upload_resource_domains"."schema_identity" !~ '[[:cntrl:]]' AND length("upload_resource_domains"."quota_domain") BETWEEN 1 AND 512 AND "upload_resource_domains"."quota_domain" = btrim("upload_resource_domains"."quota_domain") AND "upload_resource_domains"."quota_domain" !~ '[[:cntrl:]]' AND length("upload_resource_domains"."writer_generation") BETWEEN 1 AND 512 AND "upload_resource_domains"."writer_generation" = btrim("upload_resource_domains"."writer_generation") AND "upload_resource_domains"."writer_generation" !~ '[[:cntrl:]]' AND length("upload_resource_domains"."audit_id") BETWEEN 1 AND 512 AND "upload_resource_domains"."audit_id" = btrim("upload_resource_domains"."audit_id") AND "upload_resource_domains"."audit_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "resource_domain_bytes" CHECK ("upload_resource_domains"."capacity_bytes" BETWEEN 1 AND 9007199254740991 AND "upload_resource_domains"."headroom_bytes" BETWEEN 0 AND 9007199254740991 AND "upload_resource_domains"."baseline_bytes" BETWEEN 0 AND 9007199254740991 AND "upload_resource_domains"."outstanding_bytes" BETWEEN 0 AND 9007199254740991
    AND "upload_resource_domains"."headroom_bytes" + "upload_resource_domains"."baseline_bytes" + "upload_resource_domains"."outstanding_bytes" <= "upload_resource_domains"."capacity_bytes"),
	CONSTRAINT "resource_domain_objects" CHECK ("upload_resource_domains"."capacity_objects" BETWEEN 1 AND 9007199254740991 AND "upload_resource_domains"."headroom_objects" BETWEEN 0 AND 9007199254740991 AND "upload_resource_domains"."baseline_objects" BETWEEN 0 AND 9007199254740991 AND "upload_resource_domains"."outstanding_objects" BETWEEN 0 AND 9007199254740991
    AND "upload_resource_domains"."headroom_objects" + "upload_resource_domains"."baseline_objects" + "upload_resource_domains"."outstanding_objects" <= "upload_resource_domains"."capacity_objects")
);
--> statement-breakpoint
CREATE TABLE "upload_resource_policies" (
	"database_identity" text NOT NULL,
	"schema_identity" text NOT NULL,
	"quota_domain" text NOT NULL,
	"namespace" text NOT NULL,
	"policy_version" text NOT NULL,
	"writer_generation" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	CONSTRAINT "resource_policy_pk" PRIMARY KEY("database_identity","schema_identity","quota_domain","namespace","policy_version","writer_generation"),
	CONSTRAINT "resource_policy_identity" CHECK (length("upload_resource_policies"."database_identity") BETWEEN 1 AND 512 AND "upload_resource_policies"."database_identity" = btrim("upload_resource_policies"."database_identity") AND "upload_resource_policies"."database_identity" !~ '[[:cntrl:]]' AND length("upload_resource_policies"."schema_identity") BETWEEN 1 AND 512 AND "upload_resource_policies"."schema_identity" = btrim("upload_resource_policies"."schema_identity") AND "upload_resource_policies"."schema_identity" !~ '[[:cntrl:]]' AND length("upload_resource_policies"."quota_domain") BETWEEN 1 AND 512 AND "upload_resource_policies"."quota_domain" = btrim("upload_resource_policies"."quota_domain") AND "upload_resource_policies"."quota_domain" !~ '[[:cntrl:]]' AND length("upload_resource_policies"."namespace") BETWEEN 1 AND 512 AND "upload_resource_policies"."namespace" = btrim("upload_resource_policies"."namespace") AND "upload_resource_policies"."namespace" !~ '[[:cntrl:]]' AND length("upload_resource_policies"."policy_version") BETWEEN 1 AND 512 AND "upload_resource_policies"."policy_version" = btrim("upload_resource_policies"."policy_version") AND "upload_resource_policies"."policy_version" !~ '[[:cntrl:]]' AND length("upload_resource_policies"."writer_generation") BETWEEN 1 AND 512 AND "upload_resource_policies"."writer_generation" = btrim("upload_resource_policies"."writer_generation") AND "upload_resource_policies"."writer_generation" !~ '[[:cntrl:]]'),
	CONSTRAINT "resource_policy_snapshot" CHECK ((
  jsonb_typeof("upload_resource_policies"."policy_snapshot") = 'object'
  AND "upload_resource_policies"."policy_snapshot" @> jsonb_build_object(
    'adapter', 'multer-crossing-byte-v1',
    'layout', 'provisioned-root-one-directory-one-file-v1',
    'allocationModel', 'audited-rounded-copies-v1',
    'stableExclusiveNamespace', true, 'allAllocationCostsBounded', true,
    'identity', jsonb_build_object('database', "upload_resource_policies"."database_identity",
      'schema', "upload_resource_policies"."schema_identity", 'quotaDomain', "upload_resource_policies"."quota_domain",
      'namespace', "upload_resource_policies"."namespace", 'policyVersion', "upload_resource_policies"."policy_version",
      'writerGeneration', "upload_resource_policies"."writer_generation"))
  AND "upload_resource_policies"."policy_snapshot" ?& ARRAY['maxFileBytes','allocationUnitBytes','allocationCopies',
    'directoryAndParentBytes','metadataBytes','temporaryBytes','additionalObjects']
  AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'maxFileBytes') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'maxFileBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'maxFileBytes')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'maxFileBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'allocationUnitBytes') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'allocationUnitBytes')::numeric BETWEEN 1 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'allocationUnitBytes')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'allocationUnitBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'allocationCopies') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'allocationCopies')::numeric BETWEEN 1 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'allocationCopies')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'allocationCopies')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'directoryAndParentBytes') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'directoryAndParentBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'directoryAndParentBytes')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'directoryAndParentBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'metadataBytes') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'metadataBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'metadataBytes')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'metadataBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'temporaryBytes') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'temporaryBytes')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'temporaryBytes')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'temporaryBytes')::numeric
        ELSE false END AND CASE WHEN jsonb_typeof("upload_resource_policies"."policy_snapshot"->'additionalObjects') = 'number'
        THEN ("upload_resource_policies"."policy_snapshot"->>'additionalObjects')::numeric BETWEEN 0 AND 9007199254740991
          AND trunc(("upload_resource_policies"."policy_snapshot"->>'additionalObjects')::numeric) = ("upload_resource_policies"."policy_snapshot"->>'additionalObjects')::numeric
        ELSE false END
) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "upload_resource_attempts" ADD CONSTRAINT "resource_attempt_policy_fk" FOREIGN KEY ("database_identity","schema_identity","quota_domain","namespace","policy_version","writer_generation") REFERENCES "public"."upload_resource_policies"("database_identity","schema_identity","quota_domain","namespace","policy_version","writer_generation") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "upload_resource_policies" ADD CONSTRAINT "resource_policy_domain_fk" FOREIGN KEY ("database_identity","schema_identity","quota_domain") REFERENCES "public"."upload_resource_domains"("database_identity","schema_identity","quota_domain") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_attempt_operation_idx" ON "upload_resource_attempts" USING btree ("database_identity","schema_identity","quota_domain","operation_id");