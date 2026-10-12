CREATE TABLE "resume_message_receipts" (
	"session_id" text NOT NULL,
	"client_message_id" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"message_id" integer,
	CONSTRAINT "resume_message_receipts_session_id_client_message_id_pk" PRIMARY KEY("session_id","client_message_id")
);
--> statement-breakpoint
ALTER TABLE "resume_message_receipts" ADD CONSTRAINT "resume_message_receipts_session_id_room_resume_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."room_resume_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_message_receipts" ADD CONSTRAINT "resume_message_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "resume_receipts_message_idx" ON "resume_message_receipts" USING btree ("message_id");
