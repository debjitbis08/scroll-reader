CREATE TABLE "gutenberg_catalog" (
	"gutenberg_id" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"subjects" text,
	"bookshelves" text,
	"language" text DEFAULT 'en',
	"issued_at" text,
	"search_vector" "tsvector"
);
--> statement-breakpoint
CREATE INDEX "idx_gutenberg_search" ON "gutenberg_catalog" USING gin ("search_vector");