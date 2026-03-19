import { eq } from 'drizzle-orm'
import { db } from './db.ts'
import { documents, chunks, cards } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import type { AIProvider } from './ai/index.ts'
import { extractDocument } from './extract.ts'
import { callSegmenter, callChunker } from './chunker.ts'
import { aiChunk } from './ai/chunk.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import { basename } from 'node:path'

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
    const elements = await extractDocument(filePath)

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
          chapter: c.chapter,
          wordCount: c.word_count,
          language: c.language,
          chunkIndex: pendingChunks.length,
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

      const newCards = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider)
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
