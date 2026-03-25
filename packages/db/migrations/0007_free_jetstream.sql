CREATE TYPE "public"."tier" AS ENUM('free', 'plus');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "file_size" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "total_elements" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "elements_processed" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "tier" "tier" DEFAULT 'free' NOT NULL;