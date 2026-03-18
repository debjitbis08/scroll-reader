import { eq } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { db } from './db.ts'
import { documents, chunks, cards, jobs } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import { extractDocument, filterByPageRange } from './extract.ts'
import { callSegmenter, callChunker } from './chunker.ts'
import { createProvider } from './ai/index.ts'
import { aiChunk } from './ai/chunk.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import type { CardType, CardStrategy } from '@scroll-reader/shared-types'
import { TRIAL_CHUNK_LIMIT, DAILY_CHUNK_LIMIT, BATCH_SIZE } from 'astro:env/server'

type PendingChunk = {
  chunkType: 'text' | 'image'
  content: string
  chapter: string | null
  wordCount: number
  language: string
  chunkIndex: number
}

/**
 * Runs the extract → chunk → generate pipeline for an uploaded document.
 *
 * 1. Extract text, filter to user-selected page range
 * 2. Segment → AI chunk → insert all chunks to DB
 * 3. Generate cards for up to DAILY_CHUNK_LIMIT chunks (drip processing)
 * 4. Remaining chunks get cards via daily cron
 */
export async function runPipeline(
  jobId: string,
  filePath: string,
  userId: string,
  documentId: string,
): Promise<void> {
  await db.update(jobs).set({ status: 'processing', startedAt: new Date() }).where(eq(jobs.id, jobId))

  try {
    // --- Extract ---
    await db.update(documents).set({ processingStatus: 'chunking' }).where(eq(documents.id, documentId))

    // Get the document's page range
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)

    let elements = await extractDocument(filePath)

    // Filter to selected page range
    if (doc.pageStart && doc.pageEnd) {
      const ext = extname(filePath).toLowerCase()
      elements = filterByPageRange(elements, ext, doc.pageStart, doc.pageEnd)
    }

    // --- Chunk (up to TRIAL_CHUNK_LIMIT text chunks) ---
    // Pass 1: segment → Pass 2: AI boundary refinement → fallback: mechanical
    const provider = createProvider()
    let textsSeen = 0
    const pendingChunks: PendingChunk[] = []

    outer: for (const el of elements) {
      if (el.type === 'image') {
        if (textsSeen >= TRIAL_CHUNK_LIMIT) break
        pendingChunks.push({
          chunkType: 'image',
          content: el.alt,
          chapter: null,
          wordCount: 0,
          language: 'en',
          chunkIndex: pendingChunks.length,
        })
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
          chunkIndex: pendingChunks.length,
        })
        textsSeen++
        if (textsSeen >= TRIAL_CHUNK_LIMIT) break outer
      }
    }

    if (pendingChunks.length === 0) {
      throw new Error('No content could be extracted from this document.')
    }

    // Insert all chunks at once
    const insertedChunks: Chunk[] = await db
      .insert(chunks)
      .values(
        pendingChunks.map((c) => ({
          userId,
          documentId,
          chunkType: c.chunkType,
          content: c.content,
          chapter: c.chapter ?? undefined,
          wordCount: c.wordCount,
          language: c.language,
          chunkIndex: c.chunkIndex,
          encrypted: false,
        })),
      )
      .returning()

    await db
      .update(documents)
      .set({ chunkCount: insertedChunks.length, processingStatus: 'generating' })
      .where(eq(documents.id, documentId))

    // Clean up temp file now — we no longer need it
    await unlink(filePath).catch(() => {})

    // --- Generate cards for today's batch ---
    const strategy = doc.cardStrategy as CardStrategy | null

    // If strategy says no cards (e.g. fiction/casual), skip generation entirely
    if (strategy && strategy.cardTypes.length === 0) {
      await db
        .update(documents)
        .set({ processingStatus: 'ready', cardCount: 0 })
        .where(eq(documents.id, documentId))
      await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))
      console.log(`[pipeline] done (no cards): doc=${documentId} chunks=${insertedChunks.length}`)
      return
    }

    await generateDailyBatch(jobId, userId, documentId, insertedChunks, strategy)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] error: job=${jobId}`, err)
    await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
    await db.update(documents).set({ processingStatus: 'error' }).where(eq(documents.id, documentId))
    await unlink(filePath).catch(() => {})
  }
}

/**
 * Generate cards for up to DAILY_CHUNK_LIMIT text chunks that don't have cards yet.
 * If all chunks have cards after this batch, mark the document as 'ready'.
 * Otherwise it stays as 'generating' for the next daily run.
 */
async function generateDailyBatch(
  jobId: string,
  userId: string,
  documentId: string,
  allChunks: Chunk[],
  strategy?: CardStrategy | null,
): Promise<void> {
  const provider = createProvider()
  const allTextChunks = allChunks.filter((c) => c.chunkType === 'text')

  // Apply chunk interval filter — only every Nth text chunk gets cards
  const interval = strategy?.chunkInterval ?? 1
  const textChunks = interval > 1
    ? allTextChunks.filter((_, i) => i % interval === 0)
    : allTextChunks

  const cardTypes = (strategy?.cardTypes as CardType[] | undefined) ?? undefined

  // Find chunks that already have cards (resume support)
  const existingCards = await db
    .select({ chunkId: cards.chunkId })
    .from(cards)
    .where(eq(cards.userId, userId))
  const chunksWithCards = new Set(existingCards.map((r) => r.chunkId))
  const remaining = textChunks.filter((c) => !chunksWithCards.has(c.id))

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)

  let totalCards = existingCards.length

  // Process only up to DAILY_CHUNK_LIMIT chunks
  const todaysBatch = remaining.slice(0, DAILY_CHUNK_LIMIT)

  for (let i = 0; i < todaysBatch.length; i += BATCH_SIZE) {
    const batch = todaysBatch.slice(i, i + BATCH_SIZE)

    for (const chunk of batch) {
      const prevChunk: Chunk | null = allChunks[allChunks.indexOf(chunk) - 1] ?? null
      const newCards = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider, cardTypes)
      await db.insert(cards).values(newCards)
      totalCards += newCards.length
    }

    await db
      .update(documents)
      .set({ cardCount: totalCards })
      .where(eq(documents.id, documentId))

    console.log(`[pipeline] batch done: doc=${documentId} cards=${totalCards}`)
  }

  const allDone = remaining.length <= DAILY_CHUNK_LIMIT

  if (allDone) {
    await db
      .update(documents)
      .set({ processingStatus: 'ready', cardCount: totalCards })
      .where(eq(documents.id, documentId))
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))
    console.log(`[pipeline] done: doc=${documentId} chunks=${allChunks.length} cards=${totalCards}`)
  } else {
    // More chunks remain — will be processed by daily cron
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))
    console.log(`[pipeline] daily batch done: doc=${documentId} cards=${totalCards}, ${remaining.length - todaysBatch.length} chunks remaining`)
  }
}

/**
 * Process the next daily batch for all documents still in 'generating' state.
 * Called by the daily cron endpoint.
 */
export async function processDaily(): Promise<void> {
  const generatingDocs = await db
    .select()
    .from(documents)
    .where(eq(documents.processingStatus, 'generating'))

  for (const doc of generatingDocs) {
    try {
      // Load all chunks for this document
      const allChunks = await db
        .select()
        .from(chunks)
        .where(eq(chunks.documentId, doc.id))
        .orderBy(chunks.chunkIndex)

      // Find or create a job
      const [job] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.documentId, doc.id))
        .orderBy(jobs.createdAt)
        .limit(1)

      const jobId = job?.id ?? (
        await db.insert(jobs).values({ userId: doc.userId, documentId: doc.id }).returning()
      )[0].id

      await generateDailyBatch(jobId, doc.userId, doc.id, allChunks, doc.cardStrategy as CardStrategy | null)
    } catch (err) {
      console.error(`[daily] error processing doc=${doc.id}:`, err)
    }
  }
}
