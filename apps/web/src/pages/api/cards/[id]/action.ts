import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { cards, cardActions } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../../lib/supabase.ts'

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const cardId = params.id!
  const body = await request.json()
  const action = body.action as string

  if (!['like', 'dismiss', 'bookmark'].includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 })
  }

  // Verify card ownership
  const [card] = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, user.id)))
    .limit(1)

  if (!card) return new Response(null, { status: 404 })

  // Toggle: delete if exists, insert if not
  const [existing] = await db
    .select({ id: cardActions.id })
    .from(cardActions)
    .where(
      and(
        eq(cardActions.userId, user.id),
        eq(cardActions.cardId, cardId),
        eq(cardActions.action, action as 'like' | 'dismiss' | 'bookmark'),
      ),
    )
    .limit(1)

  if (existing) {
    await db.delete(cardActions).where(eq(cardActions.id, existing.id))
    return new Response(JSON.stringify({ active: false }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  await db.insert(cardActions).values({
    userId: user.id,
    cardId,
    action: action as 'like' | 'dismiss' | 'bookmark',
  })

  return new Response(JSON.stringify({ active: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
