import type { APIRoute } from 'astro'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { collections, collectionDocuments } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const GET: APIRoute = async ({ request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt,
      documentCount: sql<number>`count(${collectionDocuments.documentId})::int`,
    })
    .from(collections)
    .leftJoin(collectionDocuments, eq(collectionDocuments.collectionId, collections.id))
    .where(eq(collections.userId, user.id))
    .groupBy(collections.id)
    .orderBy(collections.name)

  return new Response(JSON.stringify(rows), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const body = await request.json()
  const name = (body.name ?? '').trim()
  if (!name) {
    return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400 })
  }

  // Check for duplicate name
  const [existing] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.userId, user.id), eq(collections.name, name)))
    .limit(1)

  if (existing) {
    return new Response(JSON.stringify({ error: 'A collection with this name already exists' }), { status: 409 })
  }

  const [created] = await db
    .insert(collections)
    .values({
      userId: user.id,
      name,
      description: body.description?.trim() || null,
    })
    .returning()

  return new Response(JSON.stringify(created), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })
}
