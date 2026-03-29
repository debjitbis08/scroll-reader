CREATE TYPE "public"."usage_event_type" AS ENUM('cards_generated', 'document_processed', 'export');--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" "usage_event_type" NOT NULL,
	"quantity" integer,
	"document_id" uuid,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" DROP CONSTRAINT "ai_usage_logs_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_events_user_type_time" ON "usage_events" USING btree ("user_id","event_type","occurred_at");--> statement-breakpoint
CREATE POLICY "usage_events_select_own" ON "usage_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("usage_events"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "usage_events_insert_own" ON "usage_events" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("usage_events"."user_id" = (select auth.uid()));