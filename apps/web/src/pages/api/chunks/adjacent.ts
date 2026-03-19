import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { chunks, documents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const documentId = url.searchParams.get('documentId')
  const chunkIndex = parseInt(url.searchParams.get('chunkIndex') ?? '')
  if (!documentId || isNaN(chunkIndex)) {
    return new Response(JSON.stringify({ error: 'Missing documentId or chunkIndex' }), { status: 400 })
  }

  // Verify document ownership
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, user.id)))
    .limit(1)
  if (!doc) return new Response(null, { status: 404 })

  const [chunk] = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      chunkIndex: chunks.chunkIndex,
      chunkType: chunks.chunkType,
      chapter: chunks.chapter,
      language: chunks.language,
    })
    .from(chunks)
    .where(
      and(
        eq(chunks.documentId, documentId),
        eq(chunks.userId, user.id),
        eq(chunks.chunkIndex, chunkIndex),
      ),
    )
    .limit(1)

  if (!chunk) return new Response(null, { status: 404 })

  return new Response(JSON.stringify(chunk), {
    headers: { 'Content-Type': 'application/json' },
  })
}
