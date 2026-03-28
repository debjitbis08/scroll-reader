import type { APIRoute } from 'astro'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { feedEvents, cardScores, cards } from '@scroll-reader/db'
import { createSupabaseServer } from '../../lib/supabase.ts'
import { SR_ELIGIBLE_TYPES, sm2, type SM2Grade } from '../../lib/sr.ts'

interface ImpressionPayload {
  cardId: string
  durationMs: number
  wasSrDue: boolean
  timestamp: number
  selfGrade?: number        // SM-2 grade 0–5 from flashcard self-grade buttons
  quizSelectedIndex?: number // original option index the user tapped
}

function classifyEngagement(durationMs: number): 'scrolled_past' | 'glanced' | 'engaged' {
  if (durationMs < 1500) return 'scrolled_past'
  if (durationMs < 4000) return 'glanced'
  return 'engaged'
}

// Map engagement type to SM-2 grade (0-5)
const ENGAGEMENT_TO_SM2: Record<string, SM2Grade> = {
  scrolled_past: 0,  // total failure — didn't attempt
  glanced: 2,        // saw it but didn't engage — incorrect but familiar
  engaged: 4,        // read it through — correct after hesitation (EF-neutral)
}

const VALID_SM2_GRADES = new Set([0, 1, 2, 3, 4, 5])

export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  let body: { impressions?: unknown }
  try {
    body = await request.json()
  } catch {
    return new Response(null, { status: 400 })
  }

  const { impressions } = body
  if (!Array.isArray(impressions) || impressions.length === 0) {
    return new Response(null, { status: 400 })
  }

  // Cap batch size server-side
  const batch: ImpressionPayload[] = impressions.slice(0, 50)

  const now = new Date()

  // Classify and insert feed_events
  const eventRows = batch.map((imp) => {
    // Sanitize selfGrade
    const selfGrade = typeof imp.selfGrade === 'number' && VALID_SM2_GRADES.has(imp.selfGrade)
      ? imp.selfGrade
      : null

    return {
      userId: user.id,
      cardId: imp.cardId,
      eventType: classifyEngagement(imp.durationMs) as 'scrolled_past' | 'glanced' | 'engaged',
      dwellMs: imp.durationMs,
      selfGrade,
      timeOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
    }
  })

  await db.insert(feedEvents).values(eventRows)

  // Upsert card_scores per unique card
  const scoreUpdates = new Map<string, { shown: number; engaged: number; skipped: number }>()
  for (const row of eventRows) {
    const existing = scoreUpdates.get(row.cardId!) ?? { shown: 0, engaged: 0, skipped: 0 }
    existing.shown++
    if (row.eventType === 'engaged') existing.engaged++
    if (row.eventType === 'scrolled_past') existing.skipped++
    scoreUpdates.set(row.cardId!, existing)
  }

  for (const [cardId, counts] of scoreUpdates) {
    await db
      .insert(cardScores)
      .values({
        userId: user.id,
        cardId,
        timesShown: counts.shown,
        timesEngaged: counts.engaged,
        timesSkipped: counts.skipped,
        lastShownAt: now,
      })
      .onConflictDoUpdate({
        target: [cardScores.userId, cardScores.cardId],
        set: {
          timesShown: sql`${cardScores.timesShown} + ${counts.shown}`,
          timesEngaged: sql`${cardScores.timesEngaged} + ${counts.engaged}`,
          timesSkipped: sql`${cardScores.timesSkipped} + ${counts.skipped}`,
          lastShownAt: now,
        },
      })
  }

  // SR updates for SR-eligible cards that have a self-grade or are SR-due
  const srImpressions = batch.filter((imp) =>
    imp.wasSrDue || imp.selfGrade !== undefined || imp.quizSelectedIndex !== undefined,
  )
  for (const imp of srImpressions) {
    const engagementType = classifyEngagement(imp.durationMs)

    // Fetch card type + content (content needed for quiz answer verification)
    const [card] = await db
      .select({ cardType: cards.cardType, content: cards.content })
      .from(cards)
      .where(eq(cards.id, imp.cardId))
      .limit(1)

    if (!card || !SR_ELIGIBLE_TYPES.includes(card.cardType)) continue

    // Get current SR state
    const [scores] = await db
      .select({
        srRepetition: cardScores.srRepetition,
        srIntervalDays: cardScores.srIntervalDays,
        srEaseFactor: cardScores.srEaseFactor,
      })
      .from(cardScores)
      .where(
        and(eq(cardScores.userId, user.id), eq(cardScores.cardId, imp.cardId)),
      )
      .limit(1)

    if (!scores) continue

    // Determine SM-2 grade: self-grade > quiz answer > dwell-based
    let grade: SM2Grade
    if (typeof imp.selfGrade === 'number' && VALID_SM2_GRADES.has(imp.selfGrade)) {
      grade = imp.selfGrade as SM2Grade
    } else if (typeof imp.quizSelectedIndex === 'number' && card.cardType === 'quiz') {
      const content = card.content as { correct?: number } | null
      const isCorrect = content && imp.quizSelectedIndex === content.correct
      grade = isCorrect ? 5 : 1
    } else {
      grade = ENGAGEMENT_TO_SM2[engagementType]
    }

    const result = sm2(grade, {
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
        and(eq(cardScores.userId, user.id), eq(cardScores.cardId, imp.cardId)),
      )
  }

  return new Response(null, { status: 204 })
}
