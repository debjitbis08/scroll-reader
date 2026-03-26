ALTER TABLE "documents" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "doc_virtual_time" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "virtual_time" real DEFAULT 0 NOT NULL;