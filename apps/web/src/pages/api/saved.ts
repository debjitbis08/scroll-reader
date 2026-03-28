import type { APIRoute } from 'astro'
import { eq, and, sql, inArray, desc, or } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { cards, chunks, chunkImages, documents, cardActions } from '@scroll-reader/db'
import { createSupabaseServer } from '../../lib/supabase.ts'

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 50)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  // Fetch cards that have a 'like' or 'bookmark' action, sorted by when saved
  const savedRows = await db
    .select({
      card: cards,
      chunk: {
        id: chunks.id,
        content: chunks.content,
        chapter: chunks.chapter,
        chunkIndex: chunks.chunkIndex,
        chunkType: chunks.chunkType,
        language: chunks.language,
      },
      document: {
        id: documents.id,
        title: documents.title,
        author: documents.author,
      },
      wordCount: chunks.wordCount,
      savedAt: sql<string>`max(${cardActions.createdAt})`,
    })
    .from(cardActions)
    .innerJoin(cards, eq(cardActions.cardId, cards.id))
    .innerJoin(chunks, eq(cards.chunkId, chunks.id))
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(
      and(
        eq(cardActions.userId, user.id),
        or(eq(cardActions.action, 'like'), eq(cardActions.action, 'bookmark')),
      ),
    )
    .groupBy(cards.id, chunks.id, documents.id)
    .orderBy(desc(sql`max(${cardActions.createdAt})`))
    .limit(limit)
    .offset(offset)

  // Load all actions for these cards
  const cardIds = savedRows.map((r) => r.card.id)
  const actions = cardIds.length > 0
    ? await db
        .select({ cardId: cardActions.cardId, action: cardActions.action })
        .from(cardActions)
        .where(and(eq(cardActions.userId, user.id), inArray(cardActions.cardId, cardIds)))
    : []

  const actionMap = new Map<string, string[]>()
  for (const a of actions) {
    if (!actionMap.has(a.cardId)) actionMap.set(a.cardId, [])
    actionMap.get(a.cardId)!.push(a.action)
  }

  // Load chunk images
  const chunkIdsNeedingImages = new Set(
    savedRows
      .filter((r) => {
        const content = r.card.content as Record<string, unknown> | null
        return content && Array.isArray(content.images) && content.images.length > 0
      })
      .map((r) => r.chunk.id),
  )

  const chunkImageRows = chunkIdsNeedingImages.size > 0
    ? await db
        .select()
        .from(chunkImages)
        .where(inArray(chunkImages.chunkId, [...chunkIdsNeedingImages]))
        .orderBy(chunkImages.position)
    : []

  const chunkImageMap = new Map<string, { url: string; alt: string; position: number }[]>()
  for (const img of chunkImageRows) {
    const url = `/api/images/${img.storagePath}`
    const list = chunkImageMap.get(img.chunkId) ?? []
    list.push({ url, alt: img.altText ?? '', position: img.position })
    chunkImageMap.set(img.chunkId, list)
  }

  const result = savedRows.map((r) => ({
    card: r.card,
    chunk: r.chunk,
    document: r.document,
    actions: actionMap.get(r.card.id) ?? [],
    isSrDue: false,
    wordCount: r.wordCount ?? 0,
    chunkImageUrls: chunkImageMap.get(r.chunk.id) ?? [],
  }))

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  })
}
