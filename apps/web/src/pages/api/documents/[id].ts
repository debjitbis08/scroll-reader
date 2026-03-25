import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { documents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'
import { deleteDocument, deleteDocumentImages } from '../../../lib/storage.ts'

export const DELETE: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const docId = params.id!

  // Verify ownership then delete — cascades handle chunks, cards, jobs
  const [doc] = await db
    .select({ id: documents.id, filePath: documents.filePath })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, user.id)))
    .limit(1)

  if (!doc) return new Response(null, { status: 404 })

  // Clean up storage: original file + extracted images
  if (doc.filePath) await deleteDocument(doc.filePath).catch(() => {})
  await deleteDocumentImages(user.id, docId).catch(() => {})

  await db.delete(documents).where(eq(documents.id, docId))

  return new Response(null, { status: 204 })
}
