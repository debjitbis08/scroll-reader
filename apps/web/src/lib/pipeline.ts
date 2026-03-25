import { eq, and, sql, gte, inArray } from 'drizzle-orm'
import { writeFile, unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { db } from './db.ts'
import { documents, chunks, cards, jobs, profiles } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import { extractDocument, filterByPageRange } from './extract.ts'
import { callSegmenter, callChunker } from './chunker.ts'
import { createProvider } from './ai/index.ts'
import { aiChunk } from './ai/chunk.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import type { CardType, CardStrategy, Tier } from '@scroll-reader/shared-types'
import { TIER_LIMITS } from '@scroll-reader/shared-types'
import { BATCH_SIZE } from 'astro:env/server'
import { downloadDocument, deleteDocument } from './storage.ts'

type PendingChunk = {
  chunkType: 'text' | 'image' | 'code'
  content: string
  chapter: string | null
  wordCount: number
  language: string
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Count how many cards a user has generated today (UTC).
 */
async function cardsGeneratedToday(userId: string): Promise<number> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cards)
    .where(and(eq(cards.userId, userId), gte(cards.createdAt, todayStart)))

  return row?.count ?? 0
}

// ── Process a single document ───────────────────────────────

/**
 * Process the next batch for a document: chunk some elements, then generate
 * cards for uncharded chunks — all within the user's remaining daily budget.
 *
 * Returns the number of cards generated.
 */
export async function processDocument(doc: Document, cardBudget: number): Promise<number> {
  const filePath = doc.filePath!
  const ext = extname(filePath).toLowerCase()
  const tmpPath = `/tmp/scroll-${crypto.randomUUID()}${ext}`
  const strategy = doc.cardStrategy as CardStrategy | null

  // If strategy says no cards, finish immediately
  if (strategy && strategy.cardTypes.length === 0) {
    if (doc.processingStatus === 'chunking') {
      await db
        .update(documents)
        .set({ processingStatus: 'ready', cardCount: 0 })
        .where(eq(documents.id, doc.id))
      // Delete storage — we won't need the file
      await deleteDocument(filePath).catch(() => {})
    }
    return 0
  }

  const [job] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.documentId, doc.id))
    .orderBy(jobs.createdAt)
    .limit(1)

  const jobId = job?.id ?? (
    await db.insert(jobs).values({ userId: doc.userId, documentId: doc.id }).returning()
  )[0].id

  await db.update(jobs).set({ status: 'processing', startedAt: new Date() }).where(eq(jobs.id, jobId))

  try {
    // ── Chunking phase (if document still has unchunked elements) ──
    const elementsProcessed = doc.elementsProcessed ?? 0
    const isFullyChunked = doc.totalElements !== null && elementsProcessed >= doc.totalElements

    if (!isFullyChunked) {
      const fileBuffer = await downloadDocument(filePath)
      await writeFile(tmpPath, fileBuffer)

      let elements = await extractDocument(tmpPath)
      if (doc.pageStart && doc.pageEnd) {
        elements = filterByPageRange(elements, ext, doc.pageStart, doc.pageEnd)
      }

      await unlink(tmpPath).catch(() => {})

      const totalElements = elements.length

      // Set totalElements on first extraction
      if (doc.totalElements === null) {
        await db
          .update(documents)
          .set({ totalElements })
          .where(eq(documents.id, doc.id))
      }

      // Skip already-processed elements
      const remaining = elements.slice(elementsProcessed)

      if (remaining.length > 0) {
        const provider = createProvider()
        const pendingChunks: PendingChunk[] = []

        // Get current max chunkIndex for this document
        const [maxRow] = await db
          .select({ max: sql<number>`coalesce(max(chunk_index), -1)::int` })
          .from(chunks)
          .where(eq(chunks.documentId, doc.id))
        let nextIndex = (maxRow?.max ?? -1) + 1

        // Chunk elements until we've built up enough to fill the card budget.
        // Rough estimate: ~2 cards per text chunk, so chunk ~budget/2 text elements.
        // But always process at least a few elements to make progress.
        const targetChunks = Math.max(10, Math.ceil(cardBudget / 2))
        let textChunksSeen = 0
        let elementsThisBatch = 0

        for (const el of remaining) {
          if (textChunksSeen >= targetChunks) break

          if (el.type === 'image') {
            pendingChunks.push({
              chunkType: 'image',
              content: el.alt,
              chapter: null,
              wordCount: 0,
              language: 'en',
            })
            elementsThisBatch++
            continue
          }

          if (el.type === 'code') {
            pendingChunks.push({
              chunkType: 'code',
              content: el.content,
              chapter: el.chapter ?? null,
              wordCount: el.content.split(/\s+/).filter(Boolean).length,
              language: el.language ?? 'en',
            })
            textChunksSeen++
            elementsThisBatch++
            continue
          }

          let textChunks
          try {
            const segments = await callSegmenter(el.content)
            textChunks = await aiChunk(segments, provider)
          } catch (err) {
            console.warn(`[pipeline] AI chunking failed, falling back to mechanical:`, err)
            textChunks = await callChunker(el.content)
          }

          for (const c of textChunks) {
            pendingChunks.push({
              chunkType: 'text',
              content: c.content,
              chapter: c.chapter ?? el.chapter ?? null,
              wordCount: c.word_count,
              language: c.language,
            })
            textChunksSeen++
          }
          elementsThisBatch++
        }

        if (pendingChunks.length > 0) {
          await db
            .insert(chunks)
            .values(
              pendingChunks.map((c) => ({
                userId: doc.userId,
                documentId: doc.id,
                chunkType: c.chunkType,
                content: c.content,
                chapter: c.chapter ?? undefined,
                wordCount: c.wordCount,
                language: c.language,
                chunkIndex: nextIndex++,
                encrypted: false,
              })),
            )
        }

        const newProcessed = elementsProcessed + elementsThisBatch
        const fullyChunkedNow = newProcessed >= totalElements

        // Get updated chunk count
        const [countRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(chunks)
          .where(eq(chunks.documentId, doc.id))

        await db
          .update(documents)
          .set({
            elementsProcessed: newProcessed,
            chunkCount: countRow?.count ?? 0,
            // Move to 'generating' once fully chunked
            ...(fullyChunkedNow ? { processingStatus: 'generating' as const } : {}),
          })
          .where(eq(documents.id, doc.id))

        // Delete storage file only when fully chunked
        if (fullyChunkedNow) {
          await deleteDocument(filePath).catch(() => {})
          console.log(`[pipeline] fully chunked: doc=${doc.id} chunks=${countRow?.count}`)
        } else {
          console.log(`[pipeline] chunk progress: doc=${doc.id} elements=${newProcessed}/${totalElements}`)
        }

        if (pendingChunks.length === 0 && elementsProcessed === 0) {
          throw new Error('No content could be extracted from this document.')
        }
      }
    }

    // ── Card generation phase ──
    const cardTypes = (strategy?.cardTypes as CardType[] | undefined) ?? undefined
    const interval = strategy?.chunkInterval ?? 1

    const allChunks = await db
      .select()
      .from(chunks)
      .where(eq(chunks.documentId, doc.id))
      .orderBy(chunks.chunkIndex)

    const allTextChunks = allChunks.filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
    const eligibleChunks = interval > 1
      ? allTextChunks.filter((_, i) => i % interval === 0)
      : allTextChunks

    // Find chunks that already have cards
    const existingCards = await db
      .select({ chunkId: cards.chunkId })
      .from(cards)
      .innerJoin(chunks, eq(cards.chunkId, chunks.id))
      .where(and(eq(cards.userId, doc.userId), eq(chunks.documentId, doc.id)))
    const chunksWithCards = new Set(existingCards.map((r) => r.chunkId))
    const chunksNeedingCards = eligibleChunks.filter((c) => !chunksWithCards.has(c.id))

    const provider = createProvider()
    let cardsGenerated = 0
    let budgetLeft = cardBudget
    const attempted = new Set<string>()

    for (let i = 0; i < chunksNeedingCards.length && budgetLeft > 0; i += BATCH_SIZE) {
      const batch = chunksNeedingCards.slice(i, i + BATCH_SIZE)

      for (const chunk of batch) {
        if (budgetLeft <= 0) break

        const prevChunk: Chunk | null = allChunks[allChunks.indexOf(chunk) - 1] ?? null
        const newCards = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider, cardTypes)
        attempted.add(chunk.id)

        if (newCards.length > 0) {
          await db.insert(cards).values(newCards)
          cardsGenerated += newCards.length
          budgetLeft -= newCards.length
        }
      }
    }

    // Update card count
    const [docCardCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(cards)
      .innerJoin(chunks, eq(cards.chunkId, chunks.id))
      .where(and(eq(cards.userId, doc.userId), eq(chunks.documentId, doc.id)))

    // Re-read to check if fully chunked
    const [freshDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, doc.id))
      .limit(1)

    const fullyChunked = freshDoc!.totalElements !== null
      && (freshDoc!.elementsProcessed ?? 0) >= freshDoc!.totalElements

    // Check if all eligible chunks are done
    const postCards = await db
      .select({ chunkId: cards.chunkId })
      .from(cards)
      .innerJoin(chunks, eq(cards.chunkId, chunks.id))
      .where(and(eq(cards.userId, doc.userId), eq(chunks.documentId, doc.id)))
    const postSet = new Set(postCards.map((r) => r.chunkId))
    const stillPending = eligibleChunks.filter((c) => !postSet.has(c.id) && !attempted.has(c.id))

    const allDone = fullyChunked && stillPending.length === 0

    await db
      .update(documents)
      .set({
        cardCount: docCardCount?.count ?? 0,
        ...(allDone ? { processingStatus: 'ready' as const } : {}),
      })
      .where(eq(documents.id, doc.id))

    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))

    if (allDone) {
      console.log(`[pipeline] done: doc=${doc.id} cards=${docCardCount?.count}`)
    } else {
      console.log(`[pipeline] progress: doc=${doc.id} cards=${docCardCount?.count}, pending=${stillPending.length}`)
    }

    return cardsGenerated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] error: doc=${doc.id}`, err)
    await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
    await db.update(documents).set({ processingStatus: 'error' }).where(eq(documents.id, doc.id))
    await unlink(tmpPath).catch(() => {})
    return 0
  }
}

// ── Per-user entry point ────────────────────────────────────

/**
 * Process all active documents for a user (both chunking and generating),
 * respecting their tier's daily card limit.
 *
 * Returns the number of cards generated in this run.
 */
export async function processUser(userId: string, tier: Tier): Promise<number> {
  const dailyLimit = TIER_LIMITS[tier].cardsPerDay
  const alreadyToday = await cardsGeneratedToday(userId)
  let budget = dailyLimit - alreadyToday

  if (budget <= 0) {
    console.log(`[pipeline] user=${userId} daily card limit reached (${dailyLimit})`)
    return 0
  }

  // Process documents in order: oldest first
  const activeDocs = await db
    .select()
    .from(documents)
    .where(and(
      eq(documents.userId, userId),
      inArray(documents.processingStatus, ['chunking', 'generating']),
    ))
    .orderBy(documents.createdAt)

  let totalGenerated = 0

  for (const doc of activeDocs) {
    if (budget <= 0) break

    try {
      const generated = await processDocument(doc, budget)
      totalGenerated += generated
      budget -= generated
    } catch (err) {
      console.error(`[pipeline] error processing doc=${doc.id}:`, err)
    }
  }

  return totalGenerated
}

// ── Cron entry point ────────────────────────────────────────

/**
 * Main cron handler — call every few hours.
 *
 * For each user with active documents, chunk a batch of elements and
 * generate cards up to their tier's daily limit.
 */
export async function processCron(): Promise<void> {
  const usersWithWork = await db
    .selectDistinct({ userId: documents.userId })
    .from(documents)
    .where(inArray(documents.processingStatus, ['chunking', 'generating']))

  for (const { userId } of usersWithWork) {
    try {
      const [profile] = await db
        .select({ tier: profiles.tier })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)

      const tier = (profile?.tier ?? 'free') as Tier
      await processUser(userId, tier)
    } catch (err) {
      console.error(`[cron] error for user=${userId}:`, err)
    }
  }
}
