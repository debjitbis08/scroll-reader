import type { APIRoute } from 'astro'
import { eq, and, sql, inArray, notInArray, desc, or } from 'drizzle-orm'
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

  // Client sends IDs of cards already loaded so we can exclude them
  const clientExcludeParam = url.searchParams.get('exclude') ?? ''
  const clientExcludeIds = clientExcludeParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

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

  // Combined exclusion set (server-side recent + dismissed + client-side loaded)
  const excludeIds = [...new Set([...recentCardIds, ...dismissedIds, ...clientExcludeIds])]

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
  // Uses a WHERE EXISTS subquery instead of JOIN to avoid row amplification
  // from potential duplicate card_scores rows.

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
    })
    .from(cards)
    .innerJoin(chunks, eq(cards.chunkId, chunks.id))
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(
      and(
        eq(cards.userId, user.id),
        inArray(cards.cardType, ['flashcard', 'quiz']),
        // SR-due check via subquery — no JOIN, no row amplification
        sql`EXISTS (
          SELECT 1 FROM card_scores cs
          WHERE cs.card_id = ${cards.id}
            AND cs.user_id = ${cards.userId}
            AND cs.sr_due_at <= now()
          LIMIT 1
        )`,
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
    isSrDue: boolean
  }

  const srPairs: FeedRow[] = []
  const srCardIds = new Set<string>()
  const companionCardIds = new Set<string>()
  const usedCompanionChunks = new Set<string>()
  for (const srCard of srDueCards) {
    // Only insert a companion once per chunk, not once per SR card
    const companion = companionMap.get(srCard.chunk.id)
    if (companion && !usedCompanionChunks.has(srCard.chunk.id)) {
      srPairs.push({ ...companion, isSrDue: false })
      companionCardIds.add(companion.card.id)
      usedCompanionChunks.add(srCard.chunk.id)
    }
    srPairs.push({ ...srCard, isSrDue: true })
    srCardIds.add(srCard.card.id)
  }

  // --- 3. Regular feed cards ---
  // No JOIN on card_scores — cooldown is checked via a WHERE subquery
  // to prevent row amplification from duplicate card_scores rows.

  const remainingSlots = limit - srPairs.length
  const allExcludeIds = [...new Set([...excludeIds, ...srCardIds, ...companionCardIds])]

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

  // Cooldown via subquery: cards with no card_scores row are always eligible.
  // Cards with scores must pass engagement-based cooldown or be SR-due.
  const cooldownSubquery = sql`(
    NOT EXISTS (
      SELECT 1 FROM card_scores cs
      WHERE cs.card_id = ${cards.id} AND cs.user_id = ${cards.userId}
    )
    OR EXISTS (
      SELECT 1 FROM card_scores cs
      WHERE cs.card_id = ${cards.id}
        AND cs.user_id = ${cards.userId}
        AND (
          cs.last_shown_at IS NULL
          OR cs.last_shown_at < now() - interval '1 day' * (
            CASE
              WHEN cs.times_skipped > cs.times_engaged THEN 14
              WHEN cs.times_engaged > 0 THEN 7
              ELSE 3
            END
          )
          OR cs.sr_due_at <= now()
        )
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
        })
        .from(cards)
        .innerJoin(chunks, eq(cards.chunkId, chunks.id))
        .innerJoin(documents, eq(chunks.documentId, documents.id))
        .where(and(
          eq(cards.userId, user.id),
          inArray(cards.cardType, [...eligibleTypes]),
          allExcludeIds.length > 0 ? notInArray(cards.id, allExcludeIds) : undefined,
          // Casual docs: no flashcard/quiz
          or(
            sql`${documents.readingGoal} IS NULL`,
            sql`${documents.readingGoal} != 'casual'`,
            notInArray(cards.cardType, [...STUDY_ONLY_TYPES]),
          ),
          cooldownSubquery,
          prerequisiteGate,
        ))
        .orderBy(sql`random()`)
        .limit(remainingSlots * 3) // Over-fetch for affinity scoring
    : []

  // --- 4. Type affinity scoring + selection ---
  // Fetch scores separately to avoid JOIN amplification
  const regularCardIds = regularCards.map((r) => r.card.id)
  const scoreRows = regularCardIds.length > 0
    ? await db
        .select({
          cardId: cardScores.cardId,
          timesShown: sql<number>`max(${cardScores.timesShown})::int`,
          timesEngaged: sql<number>`max(${cardScores.timesEngaged})::int`,
        })
        .from(cardScores)
        .where(and(eq(cardScores.userId, user.id), inArray(cardScores.cardId, regularCardIds)))
        .groupBy(cardScores.cardId)
    : []

  const scoreMap = new Map<string, { timesShown: number; timesEngaged: number }>()
  for (const row of scoreRows) {
    scoreMap.set(row.cardId, { timesShown: row.timesShown, timesEngaged: row.timesEngaged })
  }

  // Score regular cards: affinity * random jitter
  const scored = regularCards.map((r) => {
    const scores = scoreMap.get(r.card.id)
    const affinity = affinityMap.get(r.card.cardType) ?? 0.5 // default 50% for unseen types
    const neverShown = !scores || scores.timesShown === 0
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
      isSrDue: r.isSrDue,
      wordCount: r.wordCount ?? 0,
    }
  }

  // SR pairs first (companion + review card), then regular cards
  const result = [
    ...srPairs.map(toFeedItem),
    ...selectedRegular.map((r) => toFeedItem({ ...r, isSrDue: false })),
  ]

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  })
}
