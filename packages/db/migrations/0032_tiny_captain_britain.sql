CREATE TABLE "gutenberg_featured" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"gutenberg_id" integer NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"rank" integer NOT NULL,
	"download_count" integer
);
--> statement-breakpoint
ALTER TABLE "gutenberg_featured" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_gutenberg_featured_category" ON "gutenberg_featured" USING btree ("category","rank");--> statement-breakpoint
CREATE POLICY "gutenberg_featured_select" ON "gutenberg_featured" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);