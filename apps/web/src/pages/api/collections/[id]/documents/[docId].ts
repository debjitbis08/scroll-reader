import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../../lib/db.ts'
import { collections, collectionDocuments } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../../../lib/supabase.ts'

export const DELETE: APIRoute = async ({ request, cookies, params }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const collectionId = params.id!
  const documentId = params.docId!

  // Verify collection ownership
  const [collection] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.userId, user.id)))
    .limit(1)

  if (!collection) return new Response(null, { status: 404 })

  await db
    .delete(collectionDocuments)
    .where(and(
      eq(collectionDocuments.collectionId, collectionId),
      eq(collectionDocuments.documentId, documentId),
    ))

  return new Response(null, { status: 204 })
}
