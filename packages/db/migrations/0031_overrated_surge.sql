ALTER TABLE "catalog_books" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_cards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gutenberg_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "catalog_books_select" ON "catalog_books" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "catalog_cards_select" ON "catalog_cards" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "catalog_chunks_select" ON "catalog_chunks" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "gutenberg_catalog_select" ON "gutenberg_catalog" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);