ALTER TABLE "documents" ADD COLUMN "card_types_override" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "chunk_interval_override" integer;