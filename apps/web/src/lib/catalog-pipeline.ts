/**
 * Catalog processing pipeline.
 *
 * Downloads an EPUB from Project Gutenberg, extracts content, and chunks it.
 * The result is stored in the catalog_* tables as a shared chunk cache.
 * Card generation happens lazily per-user via the cron pipeline.
 */

import { eq, sql } from 'drizzle-orm'
import { writeFile, unlink, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.ts'
import { catalogBooks, catalogChunks } from '@scroll-reader/db'
import {
  extractDocument, extractToc, getPageCount,
  callSegmenter, callChunker, aiChunk,
  mergeConsecutiveCode, foldSmallCodeIntoText,
} from '@scroll-reader/pipeline'
import type { ExtractConfig, ChunkerConfig, PipelineChunk } from '@scroll-reader/pipeline'
import { createProvider } from './ai/index.ts'
import { EXTRACTOR_BIN, CHUNKER_BIN, FIGURE_EXTRACT_BIN } from 'astro:env/server'

const HERE = dirname(fileURLToPath(import.meta.url))
const extractConfig: ExtractConfig = {
  extractorBin: EXTRACTOR_BIN || join(HERE, '../../../../packages/extractor/target/debug/extractor'),
  figureExtractBin: FIGURE_EXTRACT_BIN || join(HERE, '../../../../packages/extractor/figure_extract.py'),
}
const chunkerConfig: ChunkerConfig = {
  chunkerBin: CHUNKER_BIN || join(HERE, '../../../../packages/chunker/target/debug/chunker'),
}

interface PendingChunk {
  chunkType: 'text' | 'image' | 'code'
  content: string
  chapter: string | null
  wordCount: number
  language: string
}

/**
 * Process a catalog book: download → extract → chunk.
 * Cards are generated lazily per-user via the cron pipeline.
 */
export async function processCatalogBook(catalogBookId: string, epubUrl: string): Promise<void> {
  const uuid = crypto.randomUUID()
  const tmpPath = `/tmp/catalog-${uuid}.epub`
  const imageDir = `/tmp/catalog-${uuid}-images`

  try {
    // ── Download EPUB ──
    await db.update(catalogBooks)
      .set({ processingStatus: 'chunking' })
      .where(eq(catalogBooks.id, catalogBookId))

    const res = await fetch(epubUrl, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`Failed to download EPUB: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    await writeFile(tmpPath, buffer)

    // Get page count + TOC
    const [pageCount, toc] = await Promise.all([
      getPageCount(tmpPath, extractConfig),
      extractToc(tmpPath, extractConfig),
    ])

    await db.update(catalogBooks)
      .set({
        totalPages: pageCount,
        toc: toc.length > 0 ? toc : null,
      })
      .where(eq(catalogBooks.id, catalogBookId))

    // ── Extract content ──
    let elements = await extractDocument(tmpPath, extractConfig, imageDir)
    elements = mergeConsecutiveCode(elements)
    await unlink(tmpPath).catch(() => {})

    // ── Chunk all elements ──
    const provider = createProvider()
    const pendingChunks: PendingChunk[] = []

    for (const el of elements) {
      // Skip image-only elements for catalog (no user storage for images)
      if (el.type === 'image') continue

      if (el.type === 'code') {
        pendingChunks.push({
          chunkType: 'code',
          content: el.content,
          chapter: el.chapter ?? null,
          wordCount: el.content.split(/\s+/).filter(Boolean).length,
          language: el.language ?? 'en',
        })
        continue
      }

      // Text element — segment then AI chunk
      let textChunks
      try {
        const segments = await callSegmenter(el.content, chunkerConfig)
        const chunkResult = await aiChunk(segments, provider)
        textChunks = chunkResult.chunks
      } catch (err) {
        console.warn('[catalog-pipeline] AI chunking failed, falling back to mechanical:', err)
        textChunks = await callChunker(el.content, chunkerConfig)
      }

      for (const c of textChunks) {
        pendingChunks.push({
          chunkType: 'text',
          content: c.content,
          chapter: c.chapter ?? el.chapter ?? null,
          wordCount: c.word_count,
          language: c.language,
        })
      }
    }

    // Fold small code into adjacent text
    {
      const asPipeline: PipelineChunk[] = pendingChunks
        .filter((c): c is PendingChunk & { chunkType: 'text' | 'code' } =>
          c.chunkType === 'text' || c.chunkType === 'code')
        .map((c) => ({
          content: c.content,
          chapter: c.chapter,
          chunkType: c.chunkType,
          wordCount: c.wordCount,
          language: c.language,
          images: [],
        }))
      const folded = foldSmallCodeIntoText(asPipeline)
      pendingChunks.length = 0
      for (const f of folded) {
        pendingChunks.push({
          chunkType: f.chunkType,
          content: f.content,
          chapter: f.chapter,
          wordCount: f.wordCount,
          language: f.language,
        })
      }
    }

    if (pendingChunks.length === 0) {
      throw new Error('No content could be extracted from this book.')
    }

    // ── Insert chunks in batches ──
    const BATCH = 500
    const insertedChunkIds: string[] = []

    for (let i = 0; i < pendingChunks.length; i += BATCH) {
      const batch = pendingChunks.slice(i, i + BATCH)
      const rows = await db
        .insert(catalogChunks)
        .values(batch.map((c, j) => ({
          catalogBookId,
          chunkType: c.chunkType,
          content: c.content,
          chunkIndex: i + j,
          chapter: c.chapter ?? undefined,
          wordCount: c.wordCount,
          language: c.language,
        })))
        .returning({ id: catalogChunks.id })
      insertedChunkIds.push(...rows.map((r) => r.id))
    }

    // ── Finalize — chunks are ready, cards generated lazily per-user via cron ──
    await db.update(catalogBooks)
      .set({ totalChunks: insertedChunkIds.length, totalCards: 0, processingStatus: 'ready' })
      .where(eq(catalogBooks.id, catalogBookId))

    console.log(`[catalog-pipeline] done: book=${catalogBookId} chunks=${insertedChunkIds.length}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[catalog-pipeline] failed: book=${catalogBookId}`, err)
    await db.update(catalogBooks)
      .set({ processingStatus: 'error', error: message })
      .where(eq(catalogBooks.id, catalogBookId))
  } finally {
    await unlink(tmpPath).catch(() => {})
    await rm(imageDir, { recursive: true, force: true }).catch(() => {})
  }
}
