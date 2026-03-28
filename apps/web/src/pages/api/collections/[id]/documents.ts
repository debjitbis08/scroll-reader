import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { collections, collectionDocuments, documents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../../lib/supabase.ts'

export const GET: APIRoute = async ({ request, cookies, params }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const collectionId = params.id!
  const [collection] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.userId, user.id)))
    .limit(1)

  if (!collection) return new Response(null, { status: 404 })

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      author: documents.author,
      documentType: documents.documentType,
      addedAt: collectionDocuments.addedAt,
    })
    .from(collectionDocuments)
    .innerJoin(documents, eq(collectionDocuments.documentId, documents.id))
    .where(eq(collectionDocuments.collectionId, collectionId))
    .orderBy(documents.title)

  return new Response(JSON.stringify(rows), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const POST: APIRoute = async ({ request, cookies, params }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const collectionId = params.id!
  const [collection] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.id, collectionId), eq(collections.userId, user.id)))
    .limit(1)

  if (!collection) return new Response(null, { status: 404 })

  const body = await request.json()
  const documentId = body.documentId
  if (!documentId) {
    return new Response(JSON.stringify({ error: 'documentId is required' }), { status: 400 })
  }

  // Verify document ownership
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, user.id)))
    .limit(1)

  if (!doc) return new Response(null, { status: 404 })

  await db
    .insert(collectionDocuments)
    .values({ collectionId, documentId })
    .onConflictDoNothing()

  return new Response(null, { status: 204 })
}
