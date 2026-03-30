import { eq } from 'drizzle-orm'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.ts'
import { documents, chunks, cards, aiUsageLogs } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import type { AIProvider, AIUsage } from './ai/index.ts'
import {
  extractDocument, callSegmenter, callChunker, aiChunk,
  mergeConsecutiveCode, foldSmallCodeIntoText,
} from '@scroll-reader/pipeline'
import type { ExtractConfig, ChunkerConfig, PipelineChunk } from '@scroll-reader/pipeline'
import { generateCardsForChunk } from './cards/generate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const extractConfig: ExtractConfig = {
  extractorBin: process.env.EXTRACTOR_BIN || join(HERE, '../../../packages/extractor/target/debug/extractor'),
}
const chunkerConfig: ChunkerConfig = {
  chunkerBin: process.env.CHUNKER_BIN || join(HERE, '../../../packages/chunker/target/debug/chunker'),
}

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.02, output: 0.10 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
}

function estimateCost(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
  const pricing = COST_PER_MILLION[model]
  if (!pricing || promptTokens == null || completionTokens == null) return null
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000
}

function logUsage(
  userId: string,
  documentId: string,
  operation: 'chunking' | 'card_generation',
  providerName: 'gemini' | 'ollama',
  model: string,
  usage: AIUsage,
  chunkId?: string,
): void {
  const cost = estimateCost(model, usage.promptTokens, usage.completionTokens)
  db.insert(aiUsageLogs).values({
    userId,
    documentId,
    chunkId: chunkId ?? null,
    operation,
    provider: providerName,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    estimatedCostUsd: cost,
    metadata: usage.raw ?? null,
  }).catch((err) => console.warn('[usage-log] failed to log AI usage:', err))
}

/**
 * Processes a single document file through the full pipeline:
 *   extract → chunk → generate cards → store
 *
 * Status transitions: pending → chunking → generating → ready
 * On any error: status is set to 'error' and the worker continues.
 */
export async function processDocument(filePath: string, userId: string): Promise<void> {
  const fileName = basename(filePath)
  console.log(`[pipeline] Starting: ${fileName}`)

  // Insert document row
  const [doc] = await db
    .insert(documents)
    .values({
      userId,
      title: fileName,
      source: 'server',
      filePath,
      processingStatus: 'pending',
    })
    .returning()

  try {
    // --- Stage 1: Extract ---
    await setStatus(doc.id, 'chunking')
    console.log(`[pipeline] Extracting: ${fileName}`)
    let elements = await extractDocument(filePath, extractConfig)

    // Merge consecutive code elements (PDF extractor fragmentation fix)
    elements = mergeConsecutiveCode(elements)

    // --- Stage 2: Chunk text elements and build the merged chunk list ---
    // Text elements → chunker binary → ChunkerChunks
    // Image elements → inserted directly as chunk_type='image' rows
    // Both are merged in document order and assigned a sequential chunkIndex.

    type PendingChunk = {
      chunkType: 'text' | 'image' | 'code'
      content: string
      chapter: string | null
      wordCount: number
      language: string
      chunkIndex: number
    }

    const pendingChunks: PendingChunk[] = []

    // Create AI provider early — used for both chunking and card generation
    const provider = (await import('./ai/index.ts')).createProvider()

    for (const el of elements) {
      if (el.type === 'image') {
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

      if (el.type === 'code') {
        pendingChunks.push({
          chunkType: 'code',
          content: el.content,
          chapter: el.chapter ?? null,
          wordCount: el.content.split(/\s+/).filter(Boolean).length,
          language: el.language ?? 'en',
          chunkIndex: pendingChunks.length,
        })
        continue
      }

      // Pass 1 (Rust segments) → Pass 2 (AI boundary refinement)
      let textChunks
      try {
        const segments = await callSegmenter(el.content, chunkerConfig)
        const chunkResult = await aiChunk(segments, provider)
        textChunks = chunkResult.chunks
        for (const u of chunkResult.usages) {
          logUsage(userId, doc.id, 'chunking', provider.name, provider.model, u)
        }
      } catch (err) {
        console.warn(`[pipeline] AI chunking failed, falling back to mechanical:`, err)
        textChunks = await callChunker(el.content, chunkerConfig)
      }

      for (const c of textChunks) {
        pendingChunks.push({
          chunkType: 'text',
          content: c.content,
          chapter: c.chapter,
          wordCount: c.word_count,
          language: c.language,
          chunkIndex: pendingChunks.length,
        })
      }
    }

    // Fold small code chunks into adjacent text
    {
      const asPipeline: PipelineChunk[] = pendingChunks
        .filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
        .map((c) => ({
          content: c.content,
          chapter: c.chapter,
          chunkType: c.chunkType as 'text' | 'code',
          wordCount: c.wordCount,
          language: c.language,
          images: [],
        }))
      const folded = foldSmallCodeIntoText(asPipeline)
      pendingChunks.length = 0
      for (let i = 0; i < folded.length; i++) {
        pendingChunks.push({
          chunkType: folded[i].chunkType,
          content: folded[i].content,
          chapter: folded[i].chapter,
          wordCount: folded[i].wordCount,
          language: folded[i].language,
          chunkIndex: i,
        })
      }
    }

    // Insert all chunks at once; collect inserted rows for card generation
    const insertedChunks: Chunk[] = await db
      .insert(chunks)
      .values(
        pendingChunks.map((c) => ({
          userId,
          documentId: doc.id,
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

    // Update chunk count
    await db
      .update(documents)
      .set({ chunkCount: insertedChunks.length })
      .where(eq(documents.id, doc.id))

    // --- Stage 3: Generate cards ---
    await setStatus(doc.id, 'generating')
    console.log(`[pipeline] Generating cards for ${insertedChunks.length} chunks`)

    // Generate cards for text and code chunks (skip image-only chunks)
    const cardChunkRows = insertedChunks.filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
    let totalCards = 0

    for (let i = 0; i < cardChunkRows.length; i++) {
      const chunk = cardChunkRows[i]
      // Fetch chunk N-1 regardless of type — image chunks provide alt text context
      const prevChunk: Chunk | null = insertedChunks[insertedChunks.indexOf(chunk) - 1] ?? null

      const { cards: newCards, usage: cardUsage } = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider)
      if (cardUsage) {
        logUsage(userId, doc.id, 'card_generation', provider.name, provider.model, cardUsage, chunk.id)
      }
      await db.insert(cards).values(newCards)
      totalCards += newCards.length
    }

    // --- Done ---
    await db
      .update(documents)
      .set({ processingStatus: 'ready', cardCount: totalCards })
      .where(eq(documents.id, doc.id))

    console.log(`[pipeline] Done: ${fileName} — ${insertedChunks.length} chunks, ${totalCards} cards`)
  } catch (err) {
    console.error(`[pipeline] Error processing ${fileName}:`, err)
    await setStatus(doc.id, 'error')
  }
}

async function setStatus(
  docId: string,
  status: 'pending' | 'preview' | 'chunking' | 'generating' | 'ready' | 'error',
): Promise<void> {
  await db.update(documents).set({ processingStatus: status }).where(eq(documents.id, docId))
}
