import { eq, and, notInArray } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { db } from './db.ts'
import { documents, chunks, cards, jobs } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import { extractDocument } from './extract.ts'
import { callChunker } from './chunker.ts'
import { createProvider } from './ai/index.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import { TRIAL_CHUNK_LIMIT, BATCH_SIZE } from 'astro:env/server'

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
 * 1. Extract + chunk upfront (no AI calls), insert all chunks to DB
 * 2. Generate cards in batches of BATCH_SIZE, updating progress after each batch
 * 3. Resumable: skips chunks that already have cards (crash recovery)
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
    const elements = await extractDocument(filePath)

    // --- Chunk (up to TRIAL_CHUNK_LIMIT text chunks) ---
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

      const textChunks = await callChunker(el.content)
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

    // --- Generate cards in batches ---
    await generateCardsBatched(jobId, userId, documentId, insertedChunks)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] error: job=${jobId}`, err)
    await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
    await db.update(documents).set({ processingStatus: 'error' }).where(eq(documents.id, documentId))
    // Clean up temp file on error too
    await unlink(filePath).catch(() => {})
  }
}

/**
 * Generate cards for text chunks in batches of BATCH_SIZE.
 * Skips chunks that already have cards (supports resume after crash).
 * Updates card_count on the document after each batch.
 */
async function generateCardsBatched(
  jobId: string,
  userId: string,
  documentId: string,
  allChunks: Chunk[],
): Promise<void> {
  const provider = createProvider()
  const textChunks = allChunks.filter((c) => c.chunkType === 'text')

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

  // Process in batches
  for (let i = 0; i < remaining.length; i += BATCH_SIZE) {
    const batch = remaining.slice(i, i + BATCH_SIZE)

    for (const chunk of batch) {
      const prevChunk: Chunk | null = allChunks[allChunks.indexOf(chunk) - 1] ?? null
      const newCards = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider)
      await db.insert(cards).values(newCards)
      totalCards += newCards.length
    }

    // Update progress after each batch
    await db
      .update(documents)
      .set({ cardCount: totalCards })
      .where(eq(documents.id, documentId))

    console.log(`[pipeline] batch done: doc=${documentId} cards=${totalCards}/${remaining.length * 3} (est)`)
  }

  // --- Done ---
  await db
    .update(documents)
    .set({ processingStatus: 'ready', cardCount: totalCards })
    .where(eq(documents.id, documentId))
  await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))

  console.log(`[pipeline] done: doc=${documentId} chunks=${allChunks.length} cards=${totalCards}`)
}
