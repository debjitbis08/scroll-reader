import type { APIRoute } from 'astro'
import { eq, and, sql, inArray, notInArray, desc, isNull, or } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { cards, chunks, documents, cardActions, cardScores, feedEvents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../lib/supabase.ts'

type CardType = 'discover' | 'connect' | 'raw_commentary' | 'flashcard' | 'quiz' | 'glossary' | 'contrast' | 'passage'

// Cold start card type tiers
const EARLY_TYPES: CardType[] = ['discover', 'raw_commentary', 'passage']
const MID_TYPES: CardType[] = [...EARLY_TYPES, 'flashcard', 'glossary', 'contrast']
const ALL_TYPES: CardType[] = [...MID_TYPES, 'quiz']

// Card types that never appear for casual reading goal
const STUDY_ONLY_TYPES: CardType[] = ['flashcard', 'quiz']

// Companion card types surfaced before SR-due reviews
const COMPANION_TYPES: CardType[] = ['discover', 'raw_commentary']

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10'), 50)
  const now = new Date()

  // --- 1. User context ---

  // Cold start: how many distinct cards has the user seen?
  const [coldStart] = await db
    .select({ count: sql<number>`count(distinct ${cardScores.cardId})::int` })
    .from(cardScores)
    .where(eq(cardScores.userId, user.id))
  const totalShown = coldStart?.count ?? 0

  // Eligible card types based on cold start phase
  let eligibleTypes: CardType[]
  if (totalShown <= 30) eligibleTypes = EARLY_TYPES
  else if (totalShown <= 80) eligibleTypes = MID_TYPES
  else eligibleTypes = ALL_TYPES

  // Recently shown card IDs (dedup — last 20)
  const recentRows = await db
    .select({ cardId: feedEvents.cardId })
    .from(feedEvents)
    .where(eq(feedEvents.userId, user.id))
    .orderBy(desc(feedEvents.createdAt))
    .limit(20)
  const recentCardIds = recentRows
    .map((r) => r.cardId)
    .filter((id): id is string => id != null)

  // Dismissed card IDs — permanently excluded
  const dismissedRows = await db
    .select({ cardId: cardActions.cardId })
    .from(cardActions)
    .where(and(eq(cardActions.userId, user.id), eq(cardActions.action, 'dismiss')))
  const dismissedIds = dismissedRows.map((r) => r.cardId)

  // Combined exclusion set
  const excludeIds = [...new Set([...recentCardIds, ...dismissedIds])]

  // Type affinity: engagement ratio per card type
  const affinityRows = await db
    .select({
      cardType: cards.cardType,
      totalShown: sql<number>`sum(${cardScores.timesShown})::int`,
      totalEngaged: sql<number>`sum(${cardScores.timesEngaged})::int`,
    })
    .from(cardScores)
    .innerJoin(cards, eq(cards.id, cardScores.cardId))
    .where(eq(cardScores.userId, user.id))
    .groupBy(cards.cardType)

  const affinityMap = new Map<string, number>()
  for (const row of affinityRows) {
    if (row.totalShown > 0) {
      affinityMap.set(row.cardType, row.totalEngaged / row.totalShown)
    }
  }

  // --- 2. SR-due cards with companions ---

  const srDueCards = await db
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
      srDueAt: cardScores.srDueAt,
    })
    .from(cards)
    .innerJoin(chunks, eq(cards.chunkId, chunks.id))
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .innerJoin(
      cardScores,
      and(eq(cardScores.cardId, cards.id), eq(cardScores.userId, cards.userId)),
    )
    .where(
      and(
        eq(cards.userId, user.id),
        inArray(cards.cardType, ['flashcard', 'quiz']),
        sql`${cardScores.srDueAt} <= now()`,
        // Study/reflective only — never serve SR cards for casual docs
        sql`${documents.readingGoal} IS NULL OR ${documents.readingGoal} != 'casual'`,
        // Exclude dismissed
        excludeIds.length > 0
          ? notInArray(cards.id, excludeIds)
          : undefined,
      ),
    )
    .limit(Math.ceil(limit / 3)) // SR cards get up to 1/3 of slots

  // Fetch companions for SR-due cards
  const srChunkIds = [...new Set(srDueCards.map((r) => r.chunk.id))]
  const companionRows = srChunkIds.length > 0
    ? await db
        .selectDistinctOn([chunks.id], {
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
          chunkId: chunks.id,
        })
        .from(cards)
        .innerJoin(chunks, eq(cards.chunkId, chunks.id))
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .where(
          and(
            eq(cards.userId, user.id),
            inArray(cards.chunkId, srChunkIds),
            inArray(cards.cardType, [...COMPANION_TYPES]),
          ),
        )
        .orderBy(chunks.id, cards.createdAt)
    : []

  // Build companion lookup: chunkId → companion card row
  const companionMap = new Map<string, (typeof companionRows)[number]>()
  for (const row of companionRows) {
    companionMap.set(row.chunkId, row)
  }

  // Interleave: companion before its SR card
  type FeedRow = {
    card: typeof cards.$inferSelect
    chunk: { id: string; content: string; chapter: string | null; chunkIndex: number; chunkType: string; language: string | null }
    document: { id: string; title: string; author: string | null }
    wordCount: number | null
    srDueAt: Date | null
  }

  const srPairs: FeedRow[] = []
  const srCardIds = new Set<string>()
  const companionCardIds = new Set<string>()
  for (const srCard of srDueCards) {
    const companion = companionMap.get(srCard.chunk.id)
    if (companion) {
      srPairs.push({ ...companion, srDueAt: null })
      companionCardIds.add(companion.card.id)
    }
    srPairs.push(srCard)
    srCardIds.add(srCard.card.id)
  }

  // --- 3. Regular feed cards ---

  const remainingSlots = limit - srPairs.length
  const allExcludeIds = [...new Set([...excludeIds, ...srCardIds, ...companionCardIds])]

  // Build conditions for regular cards
  const regularConditions = [
    eq(cards.userId, user.id),
    inArray(cards.cardType, [...eligibleTypes]),
    // Exclude SR cards and companions already selected
    allExcludeIds.length > 0 ? notInArray(cards.id, allExcludeIds) : undefined,
    // Casual docs: no flashcard/quiz
    or(
      sql`${documents.readingGoal} IS NULL`,
      sql`${documents.readingGoal} != 'casual'`,
      notInArray(cards.cardType, [...STUDY_ONLY_TYPES]),
    ),
  ]

  // Casual cooldown: non-SR cards must pass cooldown check
  // Cards never shown (no card_scores row) are always eligible
  // Cards with scores must pass the engagement-based cooldown
  const cooldownCondition = or(
    isNull(cardScores.lastShownAt),
    sql`${cardScores.lastShownAt} < now() - interval '1 day' * (
      CASE
        WHEN ${cardScores.timesSkipped} > ${cardScores.timesEngaged} THEN 14
        WHEN ${cardScores.timesEngaged} > 0 THEN 7
        ELSE 3
      END
    )`,
    // SR-due cards bypass cooldown (already handled above, but just in case)
    sql`${cardScores.srDueAt} <= now()`,
  )

  // Chunk prerequisite gate: quiz cards require engagement on a non-quiz card from same chunk
  const userId = user.id
  const prerequisiteGate = sql`(
    ${cards.cardType} != 'quiz'
    OR EXISTS (
      SELECT 1 FROM feed_events fe
      JOIN cards c2 ON c2.id = fe.card_id
      WHERE c2.chunk_id = ${cards.chunkId}
        AND c2.card_type != 'quiz'
        AND fe.user_id = ${userId}
        AND fe.event_type = 'engaged'
    )
    OR EXISTS (
      SELECT 1 FROM card_actions ca2
      JOIN cards c3 ON c3.id = ca2.card_id
      WHERE c3.chunk_id = ${cards.chunkId}
        AND c3.card_type != 'quiz'
        AND ca2.user_id = ${userId}
        AND ca2.action = 'like'
    )
  )`

  const regularCards = remainingSlots > 0
    ? await db
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
          srDueAt: cardScores.srDueAt,
          timesShown: cardScores.timesShown,
          timesEngaged: cardScores.timesEngaged,
        })
        .from(cards)
        .innerJoin(chunks, eq(cards.chunkId, chunks.id))
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .leftJoin(
          cardScores,
          and(eq(cardScores.cardId, cards.id), eq(cardScores.userId, cards.userId)),
        )
        .where(and(...regularConditions, cooldownCondition, prerequisiteGate))
        .orderBy(sql`random()`)
        .limit(remainingSlots * 3) // Over-fetch for affinity scoring
    : []

  // --- 4. Type affinity scoring + selection ---

  // Score regular cards: affinity * random jitter
  const scored = regularCards.map((r) => {
    const affinity = affinityMap.get(r.card.cardType) ?? 0.5 // default 50% for unseen types
    const neverShown = r.timesShown == null || r.timesShown === 0
    // Boost never-shown cards so new content surfaces
    const noveltyBoost = neverShown ? 1.5 : 1.0
    const score = affinity * noveltyBoost * (0.5 + Math.random())
    return { ...r, score }
  })

  // Sort by score descending, take what we need
  scored.sort((a, b) => b.score - a.score)
  const selectedRegular = scored.slice(0, remainingSlots)

  // --- 5. Merge and build response ---

  // Load actions for all cards in one query
  const allCardIds = [
    ...srPairs.map((r) => r.card.id),
    ...selectedRegular.map((r) => r.card.id),
  ]

  const actions = allCardIds.length > 0
    ? await db
        .select({ cardId: cardActions.cardId, action: cardActions.action })
        .from(cardActions)
        .where(and(eq(cardActions.userId, user.id), inArray(cardActions.cardId, allCardIds)))
    : []

  const actionMap = new Map<string, string[]>()
  for (const a of actions) {
    if (!actionMap.has(a.cardId)) actionMap.set(a.cardId, [])
    actionMap.get(a.cardId)!.push(a.action)
  }

  function toFeedItem(r: FeedRow) {
    return {
      card: r.card,
      chunk: r.chunk,
      document: r.document,
      actions: actionMap.get(r.card.id) ?? [],
      isSrDue: r.srDueAt != null && r.srDueAt <= now,
      wordCount: r.wordCount ?? 0,
    }
  }

  // SR pairs first (companion + review card), then regular cards
  const result = [
    ...srPairs.map(toFeedItem),
    ...selectedRegular.map(toFeedItem),
  ]

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  })
}
