# Scroll Reader — Engagement Tracking Implementation

## Overview

Engagement tracking has two layers:
- **Implicit signals** — system-observed, duration-based, stored in `feed_events`
- **Explicit signals** — user-initiated actions, stored in `card_actions` (already built)

Both feed the feed algorithm: implicit signals drive type affinity scoring and the chunk prerequisite gate; explicit signals drive spaced repetition and permanent exclusions.

### Two modes of use

The app is not only a study tool. It is also a **passive scroll replacement** — something pleasant and enriching to read instead of social media. The engagement system must serve both modes:

- **Passive scrolling** — the user opens the app to browse interesting content (discover, passage, raw_commentary, glossary, contrast). No quizzes, no pressure. The feed should feel like a curated reading experience, not a flashcard drill. The `casual` reading goal maps to this mode.
- **Active study** — the user wants to learn and retain material (flashcard, quiz + companion resurfacing). SR scheduling, prerequisite gates, and cold start ramps apply here. The `study` and `reflective` reading goals map to this mode.

The engagement tracker captures signals from both modes identically — the **feed algorithm** is where the distinction matters. A user scrolling casually still generates `engaged` / `glanced` / `scrolled_past` events, and those still feed type affinity scoring. But SR scheduling and quiz eligibility only activate for documents with a non-casual reading goal.

---

## 1. Schema Changes

### Reuse `feed_events` (exists, currently unused)

The existing `feed_events` table already has the right shape. Update the `feed_event_type` enum to match engagement classification:

```sql
-- Replace the current enum values with:
ALTER TYPE feed_event_type RENAME TO feed_event_type_old;
CREATE TYPE feed_event_type AS ENUM ('scrolled_past', 'glanced', 'engaged');
ALTER TABLE feed_events ALTER COLUMN event_type TYPE feed_event_type USING event_type::text::feed_event_type;
DROP TYPE feed_event_type_old;
```

The table already has: `id`, `user_id`, `card_id`, `event_type`, `dwell_ms`, `time_of_day`, `day_of_week`, `created_at`. All of these are useful. No structural changes needed — just the enum swap.

### `card_scores` (new)

Materialized aggregate to avoid scanning `feed_events` on every feed request:

```sql
CREATE TABLE card_scores (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  times_shown integer NOT NULL DEFAULT 0,
  times_engaged integer NOT NULL DEFAULT 0,
  times_skipped integer NOT NULL DEFAULT 0,
  last_shown_at timestamptz,
  sr_interval_days real DEFAULT 1,
  sr_due_at timestamptz,
  sr_ease_factor real DEFAULT 2.5,
  PRIMARY KEY (user_id, card_id)
);
```

### No `user_feed_state` table

Recent cards are derived from `feed_events` directly:

```sql
SELECT card_id FROM feed_events
WHERE user_id = :user_id
ORDER BY created_at DESC
LIMIT 20
```

`total_cards_shown` for cold start ramp:

```sql
SELECT COUNT(DISTINCT card_id) FROM card_scores
WHERE user_id = :user_id
```

Both are cheap with the existing `(user_id, created_at DESC)` index on `feed_events`.

---

## 2. Engagement Classification

Duration is measured from when a card enters viewport ownership to when it loses it.

| Type | Threshold | Meaning |
|------|-----------|---------|
| `scrolled_past` | `duration_ms < 1500` | User did not read |
| `glanced` | `1500 – 4000 ms` | Partially read, neutral signal |
| `engaged` | `> 4000 ms` | Read — satisfies chunk prerequisite gate |

Fixed thresholds for v1. Word-count-adjusted thresholds deferred until real usage data validates the cutoffs.

---

## 3. Viewport Ownership — Client Implementation

Multiple cards are visible simultaneously in the feed. Only the card whose vertical center is closest to the viewport center "owns" the impression timer at any given time.

### Ownership detection

```typescript
function getOwnerCard(cards: Element[]): Element | null {
  const viewportMid = window.innerHeight / 2

  return cards.reduce((closest, card) => {
    const rect = card.getBoundingClientRect()
    const cardMid = rect.top + rect.height / 2
    const distance = Math.abs(cardMid - viewportMid)

    if (!closest) return card

    const closestRect = closest.getBoundingClientRect()
    const closestMid = closestRect.top + closestRect.height / 2
    const closestDistance = Math.abs(closestMid - viewportMid)

    return distance < closestDistance ? card : closest
  }, null as Element | null)
}
```

### Timer management with client-side batching

Impressions are buffered in memory and flushed periodically, not sent one at a time.

```typescript
interface PendingImpression {
  cardId: string
  durationMs: number
  wasSrDue: boolean
  timestamp: number
}

const FLUSH_INTERVAL_MS = 10_000 // flush every 10 seconds
const MAX_BUFFER_SIZE = 20       // flush if buffer hits 20

const state = {
  currentCardId: null as string | null,
  currentSrDue: false,
  startTime: null as number | null,
  buffer: [] as PendingImpression[],
}

function bufferImpression(cardId: string, durationMs: number, wasSrDue: boolean) {
  state.buffer.push({ cardId, durationMs, wasSrDue, timestamp: Date.now() })
  if (state.buffer.length >= MAX_BUFFER_SIZE) {
    flushImpressions()
  }
}

function flushImpressions() {
  if (state.buffer.length === 0) return
  const batch = state.buffer.splice(0)
  // sendBeacon for reliability on page unload
  navigator.sendBeacon(
    '/api/impressions/batch',
    JSON.stringify({ impressions: batch }),
  )
}

function transferOwnership(newCardId: string, isSrDue: boolean) {
  if (state.currentCardId && state.startTime) {
    const duration = Date.now() - state.startTime
    bufferImpression(state.currentCardId, duration, state.currentSrDue)
  }

  state.currentCardId = newCardId
  state.currentSrDue = isSrDue
  state.startTime = Date.now()
}

// Recalculate on every scroll event (throttled)
window.addEventListener('scroll', throttle(() => {
  const owner = getOwnerCard(
    Array.from(document.querySelectorAll('[data-card-id]'))
  )
  if (!owner) return

  const cardId = owner.dataset.cardId!
  if (cardId !== state.currentCardId) {
    const isSrDue = owner.dataset.srDue === 'true'
    transferOwnership(cardId, isSrDue)
  }
}, 100), { passive: true })

// Periodic flush
setInterval(flushImpressions, FLUSH_INTERVAL_MS)
```

### On page unload / visibility change

Flush the current card's impression and the entire buffer:

```typescript
function flushCurrentAndBuffer() {
  // Finalize current card
  if (state.currentCardId && state.startTime) {
    const duration = Date.now() - state.startTime
    bufferImpression(state.currentCardId, duration, state.currentSrDue)
    state.currentCardId = null
    state.startTime = null
  }
  flushImpressions()
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushCurrentAndBuffer()
})

// Mobile Safari doesn't always fire visibilitychange on tab close
window.addEventListener('pagehide', flushCurrentAndBuffer)
```

---

## 4. Impression Batch API Endpoint

`POST /api/impressions/batch`

Receives a batch of impressions from the client buffer. Single DB round-trip per batch.

```typescript
// Request body
{
  impressions: Array<{
    cardId: string
    durationMs: number
    wasSrDue: boolean
    timestamp: number
  }>
}

// Server handler
export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const { impressions } = await request.json()
  if (!Array.isArray(impressions) || impressions.length === 0) {
    return new Response(null, { status: 400 })
  }

  // Cap batch size server-side
  const batch = impressions.slice(0, 50)

  const now = new Date()

  // Classify and insert feed_events
  const eventRows = batch.map((imp) => {
    const engagementType =
      imp.durationMs < 1500 ? 'scrolled_past' as const :
      imp.durationMs < 4000 ? 'glanced' as const :
      'engaged' as const

    return {
      userId: user.id,
      cardId: imp.cardId,
      eventType: engagementType,
      dwellMs: imp.durationMs,
      timeOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
    }
  })

  await db.insert(feedEvents).values(eventRows)

  // Upsert card_scores per unique card
  const scoreUpdates = new Map<string, { shown: number; engaged: number; skipped: number }>()
  for (const row of eventRows) {
    const existing = scoreUpdates.get(row.cardId) ?? { shown: 0, engaged: 0, skipped: 0 }
    existing.shown++
    if (row.eventType === 'engaged') existing.engaged++
    if (row.eventType === 'scrolled_past') existing.skipped++
    scoreUpdates.set(row.cardId, existing)
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

  // SR updates for SR-due cards
  const srImpressions = batch.filter((imp) => imp.wasSrDue)
  if (srImpressions.length > 0) {
    for (const imp of srImpressions) {
      const engagementType =
        imp.durationMs < 1500 ? 'scrolled_past' :
        imp.durationMs < 4000 ? 'glanced' :
        'engaged'

      // Only process SR for scrolled_past (again) and engaged (good)
      if (engagementType === 'glanced') continue

      // Verify card is SR-eligible (flashcard or quiz)
      const [card] = await db
        .select({ cardType: cards.cardType })
        .from(cards)
        .where(eq(cards.id, imp.cardId))
        .limit(1)

      if (!card || !SR_ELIGIBLE_TYPES.includes(card.cardType)) continue

      // Get current SR state
      const [scores] = await db
        .select()
        .from(cardScores)
        .where(
          and(eq(cardScores.userId, user.id), eq(cardScores.cardId, imp.cardId)),
        )
        .limit(1)

      if (!scores) continue

      const grade: SRGrade = engagementType === 'scrolled_past' ? 'again' : 'good'
      const result = calculateNextInterval(
        grade,
        scores.srIntervalDays,
        scores.srEaseFactor,
      )

      await db
        .update(cardScores)
        .set({
          srIntervalDays: result.interval,
          srEaseFactor: result.easeFactor,
          srDueAt: result.dueAt,
        })
        .where(
          and(eq(cardScores.userId, user.id), eq(cardScores.cardId, imp.cardId)),
        )
    }
  }

  return new Response(null, { status: 204 })
}
```

---

## 5. SR Update in Card Actions Endpoint

The existing `POST /api/cards/:id/action` endpoint gains SR logic for `like`:

```typescript
// After the existing insert (action toggled ON):
if (action === 'like') {
  const [card] = await db
    .select({ cardType: cards.cardType })
    .from(cards)
    .where(eq(cards.id, cardId))
    .limit(1)

  if (card && SR_ELIGIBLE_TYPES.includes(card.cardType)) {
    const [scores] = await db
      .select()
      .from(cardScores)
      .where(
        and(eq(cardScores.userId, user.id), eq(cardScores.cardId, cardId)),
      )
      .limit(1)

    if (scores) {
      const result = calculateNextInterval('easy', scores.srIntervalDays, scores.srEaseFactor)
      await db
        .update(cardScores)
        .set({
          srIntervalDays: result.interval,
          srEaseFactor: result.easeFactor,
          srDueAt: result.dueAt,
        })
        .where(
          and(eq(cardScores.userId, user.id), eq(cardScores.cardId, cardId)),
        )
    }
  }
}
```

Dismiss has no SR effect — the card is excluded from the feed entirely via the existing toggle.

---

## 6. SM-2 Algorithm — Shared by Both Endpoints

Uses the standard SM-2 algorithm (Wozniak 1990) with grades 0-5. Our engagement signals map to a subset of grades:

| Signal | SM-2 grade | EF effect | Meaning |
|--------|-----------|-----------|---------|
| `scrolled_past` on SR-due card | 0 | -0.80 | Total failure — didn't attempt |
| `glanced` on SR-due card | 2 | -0.32 | Saw it but didn't engage — incorrect but familiar |
| `engaged` on SR-due card | 4 | 0.00 (neutral) | Read it through — correct after hesitation |
| `like` on SR-eligible card | 5 | +0.10 | Active positive signal — perfect recall |

Grade 4 is the EF-neutral point — this is deliberate. Without it, every successful recall would boost EF, inflating intervals over time. Only an explicit `like` increases EF. Grade 3 (correct with significant effort, slight EF decrease) is reserved for a future "didn't understand" button.

`card_scores` tracks three SM-2 variables per card: `sr_repetition` (n), `sr_interval_days` (I), `sr_ease_factor` (EF).

```typescript
// lib/sr.ts

export const SR_ELIGIBLE_TYPES = ['flashcard', 'quiz'] as const

export type SM2Grade = 0 | 2 | 4 | 5

export interface SM2State {
  repetition: number   // n — consecutive successful recalls (grade >= 3)
  interval: number     // I — inter-repetition interval in days
  easeFactor: number   // EF — easiness factor, initial 2.5, minimum 1.3
}

export function sm2(grade: SM2Grade, state: SM2State): SM2State & { dueAt: Date } {
  let { repetition, interval, easeFactor } = state

  if (grade >= 3) {
    if (repetition === 0) interval = 1
    else if (repetition === 1) interval = 6
    else interval = Math.round(interval * easeFactor)
    repetition++
  } else {
    repetition = 0
    interval = 1
  }

  const diff = 5 - grade
  easeFactor = easeFactor + (0.1 - diff * (0.08 + diff * 0.02))
  if (easeFactor < 1.3) easeFactor = 1.3

  const dueAt = new Date()
  dueAt.setDate(dueAt.getDate() + interval)

  return { repetition, interval, easeFactor, dueAt }
}
```

### SR trigger responsibility — clearly separated

```
card_actions endpoint   (POST /api/cards/:id/action)
  like on SR-eligible card   → grade 5: perfect recall, increase interval
  dismiss on any card        → no SR update (card excluded from feed entirely)

impression batch endpoint  (POST /api/impressions/batch)
  scrolled_past + was_sr_due  → grade 0: total failure, reset repetition to 0
  glanced + was_sr_due        → grade 2: incorrect but familiar, reset repetition
  engaged + was_sr_due        → grade 4: correct after hesitation, advance repetition (EF unchanged)
  anything + !was_sr_due      → no SR update
```

---

## 7. Feed Payload Changes

The feed endpoint already joins cards. Add `is_sr_due` and `word_count` to the response so the client has them without extra queries:

```typescript
// In GET /api/feed, extend the select:
{
  card: { id, cardType, content, ... },
  chunk: { id, content, chapter, chunkIndex, chunkType, language },
  document: { id, title, author },
  actions: string[],
  isSrDue: boolean,     // derived from card_scores.sr_due_at <= now()
  wordCount: number,    // from chunks.word_count — cached for future threshold use
}
```

The client renders these as data attributes on the card element:

```html
<div data-card-id={card.id} data-sr-due={isSrDue}>
```

---

## 8. How These Events Feed the Algorithm

### Chunk prerequisite gate (quiz eligibility)

A quiz card for chunk X is only eligible if the user has engaged with at least one non-quiz card from the same chunk:

```sql
SELECT COUNT(*) > 0
FROM feed_events fe
JOIN cards c ON c.id = fe.card_id
WHERE c.chunk_id = :chunk_id
  AND c.card_type != 'quiz'
  AND fe.user_id = :user_id
  AND fe.event_type = 'engaged'
-- OR: a like action exists on any non-quiz card from this chunk
UNION
SELECT COUNT(*) > 0
FROM card_actions ca
JOIN cards c ON c.id = ca.card_id
WHERE c.chunk_id = :chunk_id
  AND c.card_type != 'quiz'
  AND ca.user_id = :user_id
  AND ca.action = 'like'
```

### Cold start ramp

Derived from `COUNT(DISTINCT card_id)` in `card_scores`:

| Range | Eligible card types | Notes |
|-------|---------------------|-------|
| 0 – 30 | `discover`, `raw_commentary`, `passage` | Linear from first uploaded document |
| 31 – 80 | + `flashcard`, `glossary`, `contrast` | Cap flashcard at 20% of session |
| 81+ | + `quiz` | Cap quiz at 10%. Never for `casual` reading goal |

**Reading goal interaction:** Documents with `casual` reading goal never produce quiz or flashcard cards in the feed — even if the cards exist in the database (they may have been generated before the user changed their goal). The feed query filters by joining `cards → chunks → documents` and checking `documents.reading_goal`. Discover, passage, raw_commentary, glossary, and contrast cards are always eligible regardless of reading goal — these are the backbone of the passive scroll experience.

### Type affinity scorer

Per card type, per user:

```
affinity_score = times_engaged / times_shown  (from card_scores)
```

Applied as a boost multiplier in the feed scorer. Updated automatically via the batch impression upsert.

### Deduplication

Exclude recently shown cards from the feed query:

```sql
WHERE card_id NOT IN (
  SELECT card_id FROM feed_events
  WHERE user_id = :user_id
  ORDER BY created_at DESC
  LIMIT 20
)
```

### Casual resurfacing cooldown (non-SR cards)

Cards from `casual` reading goal documents (and non-SR-eligible card types from any document) don't use spaced repetition. Instead, a simple engagement-based cooldown controls when a card can reappear after being shown:

| Engagement on last showing | Cooldown | Rationale |
|---|---|---|
| `engaged` | 7 days | They read it — don't repeat soon |
| `glanced` | 3 days | Mild interest — bring it back sooner |
| `scrolled_past` | 14 days | They skipped it — deprioritize |
| Never shown | No cooldown | Eligible immediately |

This uses `card_scores.last_shown_at` and the existing engagement counters — no new tables or fields:

```sql
-- For non-SR cards (casual documents, or discover/note/glossary/contrast/passage from any document):
WHERE cs.last_shown_at IS NULL
   OR cs.last_shown_at < now() - INTERVAL '1 day' * (
     CASE
       WHEN cs.times_skipped > cs.times_engaged THEN 14
       WHEN cs.times_engaged > 0 THEN 7
       ELSE 3
     END
   )
```

Combined with type affinity boosting and deduplication, this keeps the casual feed feeling fresh — cards the user enjoys come back at a comfortable pace, cards they skip fade away, and new cards always surface first. No study pressure, no intervals to manage.

### Spaced repetition (flashcard / quiz only)

| Signal | Source | SM-2 grade | Effect on `card_scores` |
|--------|--------|-----------|------------------------|
| `like` | card_actions | 5 (perfect) | Advance repetition, increase interval, EF +0.10 |
| `engaged` on SR-due card | feed_events | 4 (correct) | Advance repetition, interval grows, EF unchanged |
| `glanced` on SR-due card | feed_events | 2 (incorrect) | Reset repetition to 0, interval to 1 day, EF -0.32 |
| `scrolled_past` on SR-due card | feed_events | 0 (blackout) | Reset repetition to 0, interval to 1 day, EF -0.80 |
| `dismiss` | card_actions | — | Card excluded from feed entirely, no SR update |

### Companion resurfacing (discover / note cards before SR-due reviews)

Discover and note cards contain the source material that flashcards and quizzes test. When an SR-due flashcard/quiz appears in the feed, the user needs to have the underlying content fresh in memory to answer it. Rather than giving discover/note cards their own SR schedule (they have no prompt/response structure to test recall against), they **piggyback on their sibling's SR schedule**.

**How it works:** When the feed query finds a flashcard/quiz where `sr_due_at <= now()`, it also selects a discover or note card from the same `chunk_id` and places it **before** the flashcard in feed order. The pair appears together:

```
[discover card for chunk X]   ← companion, no SR state of its own
[flashcard for chunk X]       ← SR-due, drives the schedule
```

The companion card has no `sr_due_at`, `sr_interval_days`, or ease factor. It gets shown because its sibling is due — not because of its own schedule. The flashcard's SR outcome controls when the pair returns:

| User behavior | SR grade (on flashcard) | Effect |
|---|---|---|
| Reads discover card, likes flashcard | Easy | Interval grows — pair returns later |
| Reads discover card, engages flashcard | Good | Mild interval increase |
| Scrolls past both | Again | Interval resets to 1 day — pair returns tomorrow |

**Feed query for SR-due cards with companions:**

```sql
-- 1. Find SR-due flashcard/quiz cards
WITH sr_due AS (
  SELECT cs.card_id, c.chunk_id
  FROM card_scores cs
  JOIN cards c ON c.id = cs.card_id
  WHERE cs.user_id = :user_id
    AND cs.sr_due_at <= now()
    AND c.card_type IN ('flashcard', 'quiz')
),
-- 2. Find companion discover/note cards for those chunks
companions AS (
  SELECT DISTINCT ON (c.chunk_id) c.id AS card_id, c.chunk_id
  FROM cards c
  JOIN sr_due sd ON sd.chunk_id = c.chunk_id
  WHERE c.card_type IN ('discover', 'raw_commentary')
    AND c.user_id = :user_id
  ORDER BY c.chunk_id, c.created_at ASC
)
-- 3. Interleave: companion first, then SR card
SELECT card_id, chunk_id, 0 AS sort_order FROM companions
UNION ALL
SELECT card_id, chunk_id, 1 AS sort_order FROM sr_due
ORDER BY chunk_id, sort_order
```

**Why not make discover/note cards SR-eligible?** SR strengthens recall through spaced retrieval practice — the user must actively retrieve an answer. Discover and note cards are passive: the user reads them, and showing them again on a schedule is just repetition, not retrieval practice. The engagement tracker already captures whether the user read them via `engaged` events and type affinity scoring. Companion resurfacing gives them the right role: priming memory before a test, not being tested themselves.

**Companion resurfacing only applies to study/reflective goals.** For `casual` reading goal documents, flashcard/quiz cards are never served, so companions are never triggered. The discover and note cards for casual documents appear organically in the feed based on type affinity and deduplication — no SR machinery involved.

---

## 9. What Not to Build in v1

| Skipped | Reason |
|---------|--------|
| Session start/end events | Not needed until time-of-day scoring |
| "Didn't understand" flag | Useful but adds UI complexity, defer |
| Cross-user popularity signals | Privacy complexity, little gain early |
| Word-count adjusted thresholds | Fixed 4000 ms is fine to ship; validate with real data first |
| `user_feed_state` table | Derive from `feed_events` and `card_scores` directly |

---

## 10. Build Order

```
Step 1  Migrate feed_event_type enum (scrolled_past, glanced, engaged)
        Create card_scores table
Step 2  Create lib/sr.ts (SM-2 utility + SR_ELIGIBLE_TYPES)
Step 3  Implement viewport ownership logic (client, in Feed.tsx)
        - getOwnerCard, timer management, impression buffer
Step 4  Implement POST /api/impressions/batch endpoint
        - feed_events insert, card_scores upsert, SR updates
Step 5  Wire impression buffer flush: scroll transfer, visibilitychange, pagehide, periodic
Step 6  Extend feed endpoint payload with isSrDue + wordCount
Step 7  Add SR logic to card_actions endpoint (like → easy)
Step 8  Add companion resurfacing: serve discover/note before SR-due flashcard/quiz
Step 9  Add chunk prerequisite gate to feed query
Step 10 Add cold start ramp to feed eligibility filter
Step 11 Add casual resurfacing cooldown to feed query
Step 12 Add type affinity score to card scorer
```
