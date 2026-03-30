ALTER TABLE "feed_events" DROP CONSTRAINT "feed_events_card_id_cards_id_fk";
--> statement-breakpoint
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;