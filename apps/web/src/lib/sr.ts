import type { CardType } from '@scroll-reader/shared-types'

export const SR_ELIGIBLE_TYPES: CardType[] = ['flashcard', 'quiz']

/**
 * SM-2 quality grades mapped from our engagement signals:
 *
 *   0 — scrolled_past on SR-due card (total failure, didn't attempt)
 *   2 — glanced on SR-due card (saw it but didn't engage, incorrect but familiar)
 *   4 — engaged on SR-due card (correct after hesitation, EF-neutral)
 *   5 — like on SR-eligible card (active positive signal, perfect recall)
 *
 * Grade 1 (incorrect but familiar) and 3 (correct with significant effort)
 * are not distinguishable from our current signals. Grade 3 could map to a
 * future "didn't understand" button.
 *
 * EF impact: grade 4 is the neutral point (EF unchanged). This prevents
 * EF inflation from normal successful recalls — only an explicit "like"
 * boosts EF.
 */
export type SM2Grade = 0 | 2 | 4 | 5

export interface SM2State {
  repetition: number   // n — consecutive successful recalls (grade >= 3)
  interval: number     // I — inter-repetition interval in days
  easeFactor: number   // EF — easiness factor, initial 2.5, minimum 1.3
}

export interface SM2Result extends SM2State {
  dueAt: Date
}

/**
 * SM-2 algorithm as described by Wozniak (1990).
 *
 * Given the current state and a quality grade, returns the updated state
 * with the next review date.
 */
export function sm2(grade: SM2Grade, state: SM2State): SM2Result {
  let { repetition, interval, easeFactor } = state

  if (grade >= 3) {
    // Correct response
    if (repetition === 0) {
      interval = 1
    } else if (repetition === 1) {
      interval = 6
    } else {
      interval = Math.round(interval * easeFactor)
    }
    repetition++
  } else {
    // Incorrect response — reset
    repetition = 0
    interval = 1
  }

  // Update ease factor: EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  const diff = 5 - grade
  easeFactor = easeFactor + (0.1 - diff * (0.08 + diff * 0.02))
  if (easeFactor < 1.3) easeFactor = 1.3

  const dueAt = new Date()
  dueAt.setDate(dueAt.getDate() + interval)

  return { repetition, interval, easeFactor, dueAt }
}
