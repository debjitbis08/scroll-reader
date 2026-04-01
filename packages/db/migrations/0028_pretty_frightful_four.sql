ALTER TABLE "chunk_images" ADD COLUMN "document_id" uuid;--> statement-breakpoint
UPDATE "chunk_images" SET "document_id" = (SELECT "document_id" FROM "chunks" WHERE "chunks"."id" = "chunk_images"."chunk_id");--> statement-breakpoint
ALTER TABLE "chunk_images" ALTER COLUMN "document_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk_images" ADD CONSTRAINT "chunk_images_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chunk_images_document_id" ON "chunk_images" USING btree ("document_id");
