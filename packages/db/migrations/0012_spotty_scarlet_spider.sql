CREATE TABLE "card_scores" (
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"times_shown" integer DEFAULT 0 NOT NULL,
	"times_engaged" integer DEFAULT 0 NOT NULL,
	"times_skipped" integer DEFAULT 0 NOT NULL,
	"last_shown_at" timestamp with time zone,
	"sr_repetition" integer DEFAULT 0 NOT NULL,
	"sr_interval_days" real DEFAULT 1,
	"sr_due_at" timestamp with time zone,
	"sr_ease_factor" real DEFAULT 2.5,
	CONSTRAINT "card_scores_user_id_card_id_pk" PRIMARY KEY("user_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "card_scores" ADD CONSTRAINT "card_scores_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_scores" ADD CONSTRAINT "card_scores_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feed_events_user_created" ON "feed_events" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "public"."feed_events" ALTER COLUMN "event_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."feed_event_type";--> statement-breakpoint
CREATE TYPE "public"."feed_event_type" AS ENUM('scrolled_past', 'glanced', 'engaged');--> statement-breakpoint
ALTER TABLE "public"."feed_events" ALTER COLUMN "event_type" SET DATA TYPE "public"."feed_event_type" USING "event_type"::"public"."feed_event_type";