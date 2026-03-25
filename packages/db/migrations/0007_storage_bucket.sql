-- Create the private "documents" storage bucket.
-- Files are stored as {user_id}/{document_id}/original.{ext}
-- No public access, no download RLS policy — only the service role can read/write.

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Deny all access via RLS — only the service role key (which bypasses RLS) can operate.
-- This means no signed URLs, no public downloads, no client-side access.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
