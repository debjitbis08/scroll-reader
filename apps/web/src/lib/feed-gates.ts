import { eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { db } from './db.ts'
import { cards, cardScores } from '@scroll-reader/db'

/**
 * Shared feed-eligibility rules.
 *
 * Both the feed endpoint and the generation pipeline's buffer check must agree
 * on which cards the user can actually be served. When they drift, the buffer
 * counts cards the feed will never show, generation stalls, and the user is
 * left re-seeing old cards. Every gate here applies to a query whose outer
 * table is `cards`.
 */

export type FeedCardType =
  | 'discover' | 'connect' | 'raw_commentary' | 'flashcard'
  | 'quiz' | 'glossary' | 'contrast' | 'passage'

// Cold start card type tiers
export const EARLY_TYPES: FeedCardType[] = ['discover', 'raw_commentary', 'passage']
export const MID_TYPES: FeedCardType[] = [...EARLY_TYPES, 'flashcard', 'glossary', 'contrast']
export const ALL_TYPES: FeedCardType[] = [...MID_TYPES, 'quiz']

export const MASTERY_ENGAGED_THRESHOLD = 3

/** Number of distinct cards the user has ever been shown. */
export async function shownCardCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${cardScores.cardId})::int` })
    .from(cardScores)
    .where(eq(cardScores.userId, userId))
  return row?.count ?? 0
}

/** Card types the user may see, given how far through cold start they are. */
export function eligibleTypesFor(totalShown: number): FeedCardType[] {
  if (totalShown <= 30) return EARLY_TYPES
  if (totalShown <= 80) return MID_TYPES
  return ALL_TYPES
}

/**
 * Exclude cards from chunks the user has already mastered.
 * A chunk is mastered if:
 *   (a) it has flashcard/quiz cards and any has srRepetition >= 3, OR
 *   (b) it has NO flashcard/quiz cards and ALL its cards have timesEngaged >= 3
 */
export function chunkMasteryGate(userId: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM (
      SELECT chunk_id,
        bool_or(card_type IN ('flashcard', 'quiz')) AS has_sr_cards
      FROM cards c_all
      WHERE c_all.chunk_id = ${cards.chunkId} AND c_all.user_id = ${userId}
      GROUP BY chunk_id
    ) chunk_info
    WHERE CASE
      WHEN chunk_info.has_sr_cards THEN
        EXISTS (
          SELECT 1 FROM cards c_sr
          JOIN card_scores cs ON cs.card_id = c_sr.id AND cs.user_id = ${userId}
          WHERE c_sr.chunk_id = ${cards.chunkId}
            AND c_sr.card_type IN ('flashcard', 'quiz')
            AND cs.sr_repetition >= 3
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM cards c_eng
          LEFT JOIN card_scores cs ON cs.card_id = c_eng.id AND cs.user_id = ${userId}
          WHERE c_eng.chunk_id = ${cards.chunkId}
            AND c_eng.user_id = ${userId}
            AND (cs.times_engaged IS NULL OR cs.times_engaged < ${MASTERY_ENGAGED_THRESHOLD})
        )
    END
  )`
}

/**
 * Quiz/flashcard cards require the user to have at least glanced at (or liked)
 * a non-quiz/flashcard card from the same chunk.
 */
export function prerequisiteGate(userId: string): SQL {
  return sql`(
    ${cards.cardType} NOT IN ('quiz', 'flashcard')
    OR EXISTS (
      SELECT 1 FROM feed_events fe
      JOIN cards c2 ON c2.id = fe.card_id
      WHERE c2.chunk_id = ${cards.chunkId}
        AND c2.card_type NOT IN ('quiz', 'flashcard')
        AND fe.user_id = ${userId}
        AND fe.event_type IN ('glanced', 'engaged')
    )
    OR EXISTS (
      SELECT 1 FROM card_actions ca2
      JOIN cards c3 ON c3.id = ca2.card_id
      WHERE c3.chunk_id = ${cards.chunkId}
        AND c3.card_type NOT IN ('quiz', 'flashcard')
        AND ca2.user_id = ${userId}
        AND ca2.action = 'like'
    )
  )`
}

/** Card has never been shown to the user. */
export const neverShownGate: SQL = sql`NOT EXISTS (
  SELECT 1 FROM card_scores cs
  WHERE cs.card_id = ${cards.id} AND cs.user_id = ${cards.userId}
    AND cs.times_shown > 0
)`

/** Card has not been dismissed by the user. */
export const notDismissedGate: SQL = sql`NOT EXISTS (
  SELECT 1 FROM card_actions ca
  WHERE ca.card_id = ${cards.id} AND ca.user_id = ${cards.userId}
    AND ca.action = 'dismiss'
)`

// ── Adaptive buffer ─────────────────────────────────────────

/** Days of the user's recent consumption to keep ready as unseen cards. */
export const BUFFER_DAYS = 3
/** Floor so new / quiet users still have a session's worth of fresh cards. */
export const MIN_BUFFER = 30
/** Window over which consumption is measured. */
export const CONSUMPTION_WINDOW_DAYS = 7

/**
 * How many servable unseen cards to keep ready, sized to how fast the user
 * actually reads. Quiet users get a small buffer, so generation keeps running
 * in small daily amounts and the feed keeps moving through the book, instead
 * of parking on a large stock and going idle for weeks.
 *
 * @param cardsSeenPerDay  distinct cards seen per day over the recent window
 * @param dailyLimit       tier's daily generation cap (also bounds the buffer)
 */
export function adaptiveBufferTarget(cardsSeenPerDay: number, dailyLimit: number): number {
  const target = Math.ceil(cardsSeenPerDay * BUFFER_DAYS)
  return Math.min(Math.max(target, MIN_BUFFER), 2 * dailyLimit)
}
