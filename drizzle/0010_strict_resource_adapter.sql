ALTER TABLE "upload_resource_policies" DROP CONSTRAINT "resource_policy_snapshot",
  ADD CONSTRAINT "resource_policy_snapshot" CHECK ((
  jsonb_typeof("upload_resource_policies"."policy_snapshot") = 'object'
  AND "upload_resource_policies"."policy_snapshot"->>'adapter' IN ('multer-crossing-byte-v1', 'resume-strict-writer-v1')
  AND "upload_resource_policies"."policy_snapshot" @> jsonb_build_object(
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
) IS TRUE);
--> statement-breakpoint
ALTER TABLE "upload_resource_attempts" DROP CONSTRAINT "resource_attempt_snapshot",
  ADD CONSTRAINT "resource_attempt_snapshot" CHECK ((
  jsonb_typeof("upload_resource_attempts"."policy_snapshot") = 'object'
  AND "upload_resource_attempts"."policy_snapshot"->>'adapter' IN ('multer-crossing-byte-v1', 'resume-strict-writer-v1')
  AND "upload_resource_attempts"."policy_snapshot" @> jsonb_build_object(
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
) IS TRUE);
