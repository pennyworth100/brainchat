CREATE TABLE "resume_upload_attempts" (
	"storage_key" varchar(64) PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"room_id" text NOT NULL,
	"client_message_id" varchar(128) NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_upload_attempt_bounds" CHECK ("resume_upload_attempts"."reserved_bytes" > 0 AND "resume_upload_attempts"."reserved_bytes" <= 104857600 AND "resume_upload_attempts"."storage_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "resume_upload_budget" (
	"id" integer PRIMARY KEY NOT NULL,
	"capacity_bytes" bigint NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "resume_upload_budget_bounds" CHECK ("resume_upload_budget"."id" = 1 AND "resume_upload_budget"."capacity_bytes" > 0 AND "resume_upload_budget"."capacity_bytes" <= 9007199254740991 AND "resume_upload_budget"."reserved_bytes" >= 0 AND "resume_upload_budget"."reserved_bytes" <= "resume_upload_budget"."capacity_bytes")
);
