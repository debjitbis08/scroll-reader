import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { cards, cardActions, cardScores } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../../lib/supabase.ts'
import { SR_ELIGIBLE_TYPES, sm2 } from '../../../../lib/sr.ts'

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

  // Verify card ownership and fetch card type for SR
  const [card] = await db
    .select({ id: cards.id, cardType: cards.cardType })
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

  // SR update: like on flashcard/quiz → grade 5 (perfect recall)
  if (action === 'like' && SR_ELIGIBLE_TYPES.includes(card.cardType)) {
    const [scores] = await db
      .select({
        srRepetition: cardScores.srRepetition,
        srIntervalDays: cardScores.srIntervalDays,
        srEaseFactor: cardScores.srEaseFactor,
      })
      .from(cardScores)
      .where(
        and(eq(cardScores.userId, user.id), eq(cardScores.cardId, cardId)),
      )
      .limit(1)

    if (scores) {
      const result = sm2(5, {
        repetition: scores.srRepetition,
        interval: scores.srIntervalDays ?? 1,
        easeFactor: scores.srEaseFactor ?? 2.5,
      })
      await db
        .update(cardScores)
        .set({
          srRepetition: result.repetition,
          srIntervalDays: result.interval,
          srEaseFactor: result.easeFactor,
          srDueAt: result.dueAt,
        })
        .where(
          and(eq(cardScores.userId, user.id), eq(cardScores.cardId, cardId)),
        )
    }
  }

  return new Response(JSON.stringify({ active: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
