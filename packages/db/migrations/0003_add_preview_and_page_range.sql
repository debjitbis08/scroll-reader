-- Add 'preview' status to processing_status enum
ALTER TYPE "public"."processing_status" ADD VALUE IF NOT EXISTS 'preview' AFTER 'pending';--> statement-breakpoint
-- Add page range and total pages columns to documents
ALTER TABLE "documents" ADD COLUMN "total_pages" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_start" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "page_end" integer;
