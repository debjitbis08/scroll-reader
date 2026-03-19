-- Add 'code' to chunk_type enum for code block extraction
ALTER TYPE "chunk_type" ADD VALUE IF NOT EXISTS 'code';
