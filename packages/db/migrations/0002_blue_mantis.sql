CREATE TYPE "public"."card_action" AS ENUM('like', 'dismiss', 'bookmark');--> statement-breakpoint
CREATE TABLE "card_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"action" "card_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "card_actions_user_id_card_id_action_unique" UNIQUE("user_id","card_id","action")
);
--> statement-breakpoint
ALTER TABLE "card_actions" ADD CONSTRAINT "card_actions_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_actions" ADD CONSTRAINT "card_actions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_actions" ENABLE ROW LEVEL SECURITY;