ALTER TABLE "profiles" ADD COLUMN "processing_locked_by" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "processing_locked_at" timestamp with time zone;