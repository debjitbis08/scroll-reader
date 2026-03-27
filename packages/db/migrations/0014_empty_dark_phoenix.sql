CREATE TYPE "public"."document_priority" AS ENUM('pinned', 'active', 'normal');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "priority" "document_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;