DROP INDEX "idx_catalog_cards_chunk_type";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "catalog_chunk_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_catalog_cards_chunk_type" ON "catalog_cards" USING btree ("catalog_chunk_id","card_type");