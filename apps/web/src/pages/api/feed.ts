import type { APIRoute } from 'astro'
import { eq, and, sql, inArray } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { cards, chunks, documents, cardActions } from '@scroll-reader/db'
import { createSupabaseServer } from '../../lib/supabase.ts'

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10'), 50)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  const rows = await db
    .select({
      card: cards,
      chunk: {
        id: chunks.id,
        content: chunks.content,
        chapter: chunks.chapter,
        chunkIndex: chunks.chunkIndex,
      },
      document: {
        id: documents.id,
        title: documents.title,
        author: documents.author,
      },
    })
    .from(cards)
    .innerJoin(chunks, eq(cards.chunkId, chunks.id))
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(cards.userId, user.id))
    .orderBy(sql`random()`)
    .limit(limit)
    .offset(offset)

  // Load actions for returned cards in one query
  const cardIds = rows.map((r) => r.card.id)
  const actions = cardIds.length > 0
    ? await db
        .select({ cardId: cardActions.cardId, action: cardActions.action })
        .from(cardActions)
        .where(and(eq(cardActions.userId, user.id), inArray(cardActions.cardId, cardIds)))
    : []

  // Group actions by card ID
  const actionMap = new Map<string, string[]>()
  for (const a of actions) {
    if (!actionMap.has(a.cardId)) actionMap.set(a.cardId, [])
    actionMap.get(a.cardId)!.push(a.action)
  }

  const result = rows.map((r) => ({
    ...r,
    actions: actionMap.get(r.card.id) ?? [],
  }))

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  })
}
