ALTER TYPE "public"."document_source" ADD VALUE 'catalog';--> statement-breakpoint
CREATE TABLE "catalog_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gutenberg_id" integer NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"subjects" jsonb,
	"languages" jsonb,
	"cover_image_url" text,
	"total_pages" integer,
	"total_chunks" integer DEFAULT 0,
	"total_cards" integer DEFAULT 0,
	"toc" jsonb,
	"toc_classification" jsonb,
	"processing_status" "processing_status" DEFAULT 'pending',
	"error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "catalog_books_gutenberg_id_unique" UNIQUE("gutenberg_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_chunk_id" uuid NOT NULL,
	"card_type" "card_type" NOT NULL,
	"content" jsonb NOT NULL,
	"secondary_catalog_chunk_id" uuid,
	"ai_provider" text,
	"ai_model" text
);
--> statement-breakpoint
CREATE TABLE "catalog_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"catalog_book_id" uuid NOT NULL,
	"chunk_type" "chunk_type" DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chapter" text,
	"word_count" integer,
	"language" text DEFAULT 'en'
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "catalog_book_id" uuid;--> statement-breakpoint
ALTER TABLE "catalog_cards" ADD CONSTRAINT "catalog_cards_catalog_chunk_id_catalog_chunks_id_fk" FOREIGN KEY ("catalog_chunk_id") REFERENCES "public"."catalog_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_cards" ADD CONSTRAINT "catalog_cards_secondary_catalog_chunk_id_catalog_chunks_id_fk" FOREIGN KEY ("secondary_catalog_chunk_id") REFERENCES "public"."catalog_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_chunks" ADD CONSTRAINT "catalog_chunks_catalog_book_id_catalog_books_id_fk" FOREIGN KEY ("catalog_book_id") REFERENCES "public"."catalog_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_catalog_cards_chunk_type" ON "catalog_cards" USING btree ("catalog_chunk_id","card_type");--> statement-breakpoint
CREATE INDEX "idx_catalog_chunks_book" ON "catalog_chunks" USING btree ("catalog_book_id");