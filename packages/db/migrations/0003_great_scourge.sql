CREATE TYPE "public"."reading_goal" AS ENUM('casual', 'reflective', 'study');--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'fiction';--> statement-breakpoint
ALTER TYPE "public"."processing_status" ADD VALUE 'preview' BEFORE 'chunking';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "total_pages" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_start" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_end" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "reading_goal" "reading_goal";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "card_strategy" jsonb;