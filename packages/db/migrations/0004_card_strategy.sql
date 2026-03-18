-- Add 'fiction' to document_type enum
ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'fiction';

-- Create reading_goal enum
DO $$ BEGIN
  CREATE TYPE "reading_goal" AS ENUM ('casual', 'reflective', 'study');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add reading goal and card strategy columns to documents
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "reading_goal" "reading_goal";
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "card_strategy" jsonb;
