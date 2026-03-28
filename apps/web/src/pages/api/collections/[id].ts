import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { collections } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const PATCH: APIRoute = async ({ request, cookies, params }) => {
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
  const updates: Record<string, unknown> = { updatedAt: new Date() }

  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name) return new Response(JSON.stringify({ error: 'Name cannot be empty' }), { status: 400 })

    // Check duplicate
    const [dup] = await db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.userId, user.id), eq(collections.name, name)))
      .limit(1)
    if (dup && dup.id !== collectionId) {
      return new Response(JSON.stringify({ error: 'A collection with this name already exists' }), { status: 409 })
    }
    updates.name = name
  }

  if (body.description !== undefined) {
    updates.description = body.description?.trim() || null
  }

  const [updated] = await db
    .update(collections)
    .set(updates)
    .where(eq(collections.id, collectionId))
    .returning()

  return new Response(JSON.stringify(updated), {
    headers: { 'Content-Type': 'application/json' },
  })
}

export const DELETE: APIRoute = async ({ request, cookies, params }) => {
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

  await db.delete(collections).where(eq(collections.id, collectionId))

  return new Response(null, { status: 204 })
}
