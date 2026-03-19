ALTER TYPE "public"."chunk_type" ADD VALUE 'code';--> statement-breakpoint
ALTER TABLE "public"."cards" ALTER COLUMN "card_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."card_type";--> statement-breakpoint
CREATE TYPE "public"."card_type" AS ENUM('discover', 'connect', 'raw_commentary', 'sanskrit');--> statement-breakpoint
ALTER TABLE "public"."cards" ALTER COLUMN "card_type" SET DATA TYPE "public"."card_type" USING "card_type"::"public"."card_type";