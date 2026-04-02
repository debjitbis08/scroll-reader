import { eq, and, or, sql, gte, lt, isNull, inArray, asc } from 'drizzle-orm'
import { readFile, writeFile, unlink, rm } from 'node:fs/promises'
import { extname, basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.ts'
import { documents, chunks, chunkImages, cards, jobs, profiles, aiUsageLogs, usageEvents } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import {
  extractDocument, filterByPageRange, filterByToc,
  callSegmenter, callChunker, aiChunk,
  mergeConsecutiveCode, foldSmallCodeIntoText,
} from '@scroll-reader/pipeline'
import type { ImageElement, TocEntry, ExtractConfig, ChunkerConfig, AIUsage, PipelineChunk, TocSection } from '@scroll-reader/pipeline'
import { createProvider } from './ai/index.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import type { CardType, DocumentType, ReadingGoal, Tier } from '@scroll-reader/shared-types'
import { TIER_LIMITS, resolveCardStrategy } from '@scroll-reader/shared-types'
import { BATCH_SIZE, EXTRACTOR_BIN, CHUNKER_BIN, FIGURE_EXTRACT_BIN } from 'astro:env/server'
import { downloadDocument, deleteDocument, uploadImage } from './storage.ts'
import { MACHINE_ID, addAffinity, hasAffinity, cleanAffinity } from './machine.ts'
import { captureException } from './posthog.ts'

// ── Resolve binary paths ──

const HERE = dirname(fileURLToPath(import.meta.url))
const extractConfig: ExtractConfig = {
  extractorBin: EXTRACTOR_BIN || join(HERE, '../../../../packages/extractor/target/debug/extractor'),
  figureExtractBin: FIGURE_EXTRACT_BIN || join(HERE, '../../../../packages/extractor/figure_extract.py'),
}
const chunkerConfig: ChunkerConfig = {
  chunkerBin: CHUNKER_BIN || join(HERE, '../../../../packages/chunker/target/debug/chunker'),
}

// Per-million-token pricing for cost estimation
const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.02, output: 0.10 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
}

function estimateCost(model: string, usage: AIUsage): number | null {
  const pricing = COST_PER_MILLION[model]
  if (!pricing || usage.promptTokens == null || usage.completionTokens == null) return null
  const thinkingTokens = (usage.raw as Record<string, unknown> | undefined)?.thoughtsTokenCount as number | undefined
  return (
    usage.promptTokens * pricing.input
    + usage.completionTokens * pricing.output
    + (thinkingTokens ?? 0) * pricing.output
  ) / 1_000_000
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
  const cost = estimateCost(model, usage)
  db.insert(aiUsageLogs).values({
    userId,
    documentId,
    chunkId: chunkId ?? null,
    operation,
    provider: providerName,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    thinkingTokens: (usage.raw as Record<string, unknown> | undefined)?.thoughtsTokenCount as number ?? null,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    estimatedCostUsd: cost,
    metadata: usage.raw ?? null,
  }).catch((err) => console.warn('[usage-log] failed to log AI usage:', err))
}

type PendingImage = {
  file: string    // path on disk
  mime: string
  alt: string
}

type PendingChunk = {
  chunkType: 'text' | 'image' | 'code'
  content: string
  chapter: string | null
  wordCount: number
  language: string
  images?: PendingImage[]  // images to upload after chunk is inserted
}

// ── Helpers ─────────────────────────────────────────────────

const LOCK_EXPIRY_MS = 10 * 60 * 1000 // 10 minutes
const CARDS_PER_BATCH = 10

const DOC_PRIORITY_WEIGHT = 3 // priority document (oldest) gets 3x weight
const DOC_DEFAULT_WEIGHT = 1

const TIER_WEIGHTS: Record<string, number> = { plus: 2, free: 1 }

// ── Frontmatter detection ─────────────────────────────────

/**
 * Build the set of chunk IDs that fall within frontmatter TOC entries.
 * Uses page/spine matching for PDF, chapter title matching for EPUB.
 * Chunks are in document order, so once we hit mainmatter everything after is non-front.
 */
function getFrontmatterChunkIds(
  allChunks: Chunk[],
  ext: string,
  toc: TocEntry[] | null,
  classification: TocSection[] | null,
  totalPages: number,
): Set<string> {
  if (!toc || !classification || toc.length !== classification.length) return new Set()

  const frontIndices = classification
    .map((c, i) => c === 'front' ? i : -1)
    .filter((i) => i >= 0)

  if (frontIndices.length === 0) return new Set()

  const isPdf = ext === '.pdf'

  if (isPdf) {
    // Build page set for frontmatter entries (same logic as filterByToc)
    const frontPages = new Set<number>()
    for (const idx of frontIndices) {
      const entry = toc[idx]
      const nextEntry = toc.find((e, i) => i > idx && e.level <= entry.level)
      const endPage = nextEntry ? Math.max(nextEntry.page - 1, entry.page) : totalPages
      for (let p = entry.page; p <= endPage; p++) frontPages.add(p)
    }

    const result = new Set<string>()
    let currentPage = 1
    for (const chunk of allChunks) {
      const m = chunk.chapter?.match(/^Page\s+(\d+)$/i)
      if (m) currentPage = parseInt(m[1], 10)
      if (frontPages.has(currentPage)) result.add(chunk.id)
    }
    return result
  }

  // EPUB: match chunk chapter text against frontmatter TOC titles.
  // Since chunks are in document order and frontmatter precedes mainmatter,
  // once we see a chunk matching a mainmatter title, stop marking as front.
  const frontTitles = new Set(
    frontIndices.map((i) => toc[i].title.trim().toLowerCase()),
  )
  const mainTitles = new Set(
    classification
      .map((c, i) => c === 'main' ? toc[i].title.trim().toLowerCase() : null)
      .filter((t): t is string => t !== null),
  )

  // All chunks before the first mainmatter chapter heading are frontmatter.
  const result = new Set<string>()

  for (const chunk of allChunks) {
    const chapterLower = chunk.chapter?.trim().toLowerCase()

    // Once we hit a chunk whose chapter matches a mainmatter TOC title, stop.
    if (chapterLower && mainTitles.has(chapterLower)) break

    result.add(chunk.id)
  }

  return result
}

// ── Transient error detection ──────────────────────────────

const MAX_RETRIES = 3

const TRANSIENT_PATTERNS = [
  /exited null/i,       // signal kill (OOM)
  /exited 137/i,        // SIGKILL
  /exited 139/i,        // SIGSEGV
  /SIGKILL|SIGTERM/i,
  /ENOMEM|ENOSPC/i,
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED/i,
  /fetch failed/i,
  /rate limit/i,
  /Too Many Requests|429/i,
  /Service Unavailable|503/i,
]

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT_PATTERNS.some(p => p.test(msg))
}

/**
 * Count how many cards a user has generated today (UTC).
 * Uses usage_events instead of cards table so the count survives document deletion.
 */
async function cardsGeneratedToday(userId: string): Promise<number> {
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.quantity}), 0)::int` })
    .from(usageEvents)
    .where(and(
      eq(usageEvents.userId, userId),
      eq(usageEvents.eventType, 'cards_generated'),
      gte(usageEvents.occurredAt, todayStart),
    ))

  return row?.total ?? 0
}

// ── Document Locking ────────────────────────────────────────

/**
 * Acquire a document-level lock. Returns true if lock was acquired.
 * Stale locks (older than 10 min) are automatically broken.
 */
async function acquireLock(docId: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - LOCK_EXPIRY_MS)

  const result = await db
    .update(documents)
    .set({ lockedBy: MACHINE_ID, lockedAt: new Date() })
    .where(and(
      eq(documents.id, docId),
      or(
        isNull(documents.lockedBy),
        lt(documents.lockedAt, staleThreshold),
      ),
    ))
    .returning({ id: documents.id })

  return result.length > 0
}

/**
 * Release a document lock — only if this machine holds it.
 */
async function releaseLock(docId: string): Promise<void> {
  await db
    .update(documents)
    .set({ lockedBy: null, lockedAt: null })
    .where(and(eq(documents.id, docId), eq(documents.lockedBy, MACHINE_ID)))
}

/**
 * Release all locks held by this machine (clean shutdown safety net).
 */
async function releaseAllMyLocks(): Promise<void> {
  await db
    .update(documents)
    .set({ lockedBy: null, lockedAt: null })
    .where(eq(documents.lockedBy, MACHINE_ID))
}

function getDocWeight(docId: string, priorityDocId: string): number {
  return docId === priorityDocId ? DOC_PRIORITY_WEIGHT : DOC_DEFAULT_WEIGHT
}

// ── User-level Processing Lock ───────────────────────────────

/**
 * Try to acquire a processing lock for a user (stored in profiles row).
 * Uses optimistic UPDATE … WHERE to ensure only one winner across all machines.
 * Stale locks older than LOCK_EXPIRY_MS are broken automatically.
 * Returns true if acquired.
 */
async function tryAcquireUserLock(userId: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - LOCK_EXPIRY_MS)
  const result = await db
    .update(profiles)
    .set({ processingLockedBy: MACHINE_ID, processingLockedAt: new Date() })
    .where(and(
      eq(profiles.id, userId),
      or(
        isNull(profiles.processingLockedBy),
        lt(profiles.processingLockedAt, staleThreshold),
      ),
    ))
    .returning({ id: profiles.id })
  return result.length > 0
}

/**
 * Release the processing lock for a user — only if this machine holds it.
 */
async function releaseUserLock(userId: string): Promise<void> {
  await db
    .update(profiles)
    .set({ processingLockedBy: null, processingLockedAt: null })
    .where(and(eq(profiles.id, userId), eq(profiles.processingLockedBy, MACHINE_ID)))
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
  const docUuid = crypto.randomUUID()
  const tmpPath = `/tmp/scroll-${docUuid}${ext}`
  const imageDir = `/tmp/scroll-${docUuid}-images`
  const strategy = resolveCardStrategy(
    (doc.documentType ?? 'other') as DocumentType,
    (doc.readingGoal ?? 'reflective') as ReadingGoal,
  )

  // If strategy says no cards, finish immediately
  if (strategy.cardTypes.length === 0) {
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

      let elements = await extractDocument(tmpPath, extractConfig, imageDir)
      const selectedIndices = doc.selectedTocIndices as number[] | null
      const toc = doc.toc as TocEntry[] | null
      if (selectedIndices && toc && toc.length > 0) {
        elements = filterByToc(elements, ext, toc, selectedIndices, doc.totalPages ?? 1)
      } else if (doc.pageStart && doc.pageEnd) {
        elements = filterByPageRange(elements, ext, doc.pageStart, doc.pageEnd)
      }

      await unlink(tmpPath).catch(() => {})

      // Merge consecutive code elements (PDF extractor fragmentation fix)
      elements = mergeConsecutiveCode(elements)

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

        // Chunk generously — 2x the card budget to build a buffer for this
        // and the next cron run. Card generation stops at the daily budget.
        const targetChunks = Math.max(20, cardBudget * 2)
        let textChunksSeen = 0
        let elementsThisBatch = 0

        // Buffer images to attach to the next text/code chunk
        let pendingImages: PendingImage[] = []

        for (const el of remaining) {
          if (textChunksSeen >= targetChunks) break

          if (el.type === 'image') {
            const imgEl = el as ImageElement
            if (imgEl.file && imgEl.mime) {
              pendingImages.push({ file: imgEl.file, mime: imgEl.mime, alt: imgEl.alt })
            }
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
              images: pendingImages.length > 0 ? pendingImages : undefined,
            })
            pendingImages = []
            textChunksSeen++
            elementsThisBatch++
            continue
          }

          let textChunks
          try {
            const segments = await callSegmenter(el.content, chunkerConfig)
            const chunkResult = await aiChunk(segments, provider)
            textChunks = chunkResult.chunks
            for (const u of chunkResult.usages) {
              logUsage(doc.userId, doc.id, 'chunking', provider.name, provider.model, u)
            }
          } catch (err) {
            console.warn(`[pipeline] AI chunking failed, falling back to mechanical:`, err)
            textChunks = await callChunker(el.content, chunkerConfig)
          }

          // Attach buffered images to the first text chunk from this element
          for (let ci = 0; ci < textChunks.length; ci++) {
            const c = textChunks[ci]
            pendingChunks.push({
              chunkType: 'text',
              content: c.content,
              chapter: c.chapter ?? el.chapter ?? null,
              wordCount: c.word_count,
              language: c.language,
              ...(ci === 0 && pendingImages.length > 0
                ? { images: pendingImages }
                : {}),
            })
            textChunksSeen++
          }
          if (textChunks.length > 0) pendingImages = []
          elementsThisBatch++
        }

        // If there are trailing images with no following text chunk,
        // attach them to the last chunk
        if (pendingImages.length > 0 && pendingChunks.length > 0) {
          const last = pendingChunks[pendingChunks.length - 1]
          last.images = [...(last.images ?? []), ...pendingImages]
          pendingImages = []
        }

        // Fold small code chunks into adjacent text (same transform as card-tester)
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
              images: c.images ?? [],
            }))
          const folded = foldSmallCodeIntoText(asPipeline)
          // Replace pendingChunks with folded result
          pendingChunks.length = 0
          for (const f of folded) {
            pendingChunks.push({
              chunkType: f.chunkType,
              content: f.content,
              chapter: f.chapter,
              wordCount: f.wordCount,
              language: f.language,
              images: f.images.length > 0 ? f.images : undefined,
            })
          }
        }

        if (pendingChunks.length > 0) {
          const insertedChunks = await db
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
            .returning({ id: chunks.id })

          // Upload images and create chunk_images rows
          // Fetch all already-uploaded image paths for this document in one query
          const existingImages = await db
            .select({ storagePath: chunkImages.storagePath })
            .from(chunkImages)
            .where(eq(chunkImages.documentId, doc.id))
          const existingPaths = new Set(existingImages.map((r) => r.storagePath))

          for (let ci = 0; ci < pendingChunks.length; ci++) {
            const pending = pendingChunks[ci]
            if (!pending.images || pending.images.length === 0) continue

            const chunkId = insertedChunks[ci].id
            for (let pos = 0; pos < pending.images.length; pos++) {
              const img = pending.images[pos]
              try {
                const filename = basename(img.file)
                const expectedPath = `${doc.userId}/${doc.id}/images/${filename}`

                if (!existingPaths.has(expectedPath)) {
                  const buffer = await readFile(img.file)
                  await uploadImage(doc.userId, doc.id, filename, buffer, img.mime)
                  existingPaths.add(expectedPath)
                }

                await db.insert(chunkImages).values({
                  chunkId,
                  documentId: doc.id,
                  storagePath: expectedPath,
                  mimeType: img.mime,
                  altText: img.alt,
                  position: pos,
                })
              } catch (err) {
                console.warn(`[pipeline] image upload failed for ${img.file}:`, err)
              }
            }
          }
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

        // Defer image directory cleanup until after card generation
        // so we can read images from disk instead of re-downloading from Supabase

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
    let chunksNeedingCards = eligibleChunks.filter((c) => !chunksWithCards.has(c.id))

    // Prioritize mainmatter chunks so users see real content cards first,
    // not frontmatter (title page, copyright, dedication, etc.).
    const toc = doc.toc as TocEntry[] | null
    const classification = doc.tocClassification as TocSection[] | null
    const frontmatterIds = getFrontmatterChunkIds(allChunks, ext, toc, classification, doc.totalPages ?? 1)

    // Reorder: mainmatter first so users see real content, then interleave
    // frontmatter after a batch of mainmatter has been produced.
    if (frontmatterIds.size > 0) {
      const main = chunksNeedingCards.filter((c) => !frontmatterIds.has(c.id))
      const front = chunksNeedingCards.filter((c) => frontmatterIds.has(c.id))
      // Process one batch of mainmatter, then all frontmatter, then remaining mainmatter.
      const leadMain = main.slice(0, CARDS_PER_BATCH)
      const restMain = main.slice(CARDS_PER_BATCH)
      chunksNeedingCards = [...leadMain, ...front, ...restMain]
    }

    const provider = createProvider()
    let cardsGenerated = 0
    let budgetLeft = cardBudget
    const attempted = new Set<string>()

    for (let i = 0; i < chunksNeedingCards.length && budgetLeft > 0; i += BATCH_SIZE) {
      const batch = chunksNeedingCards.slice(i, i + BATCH_SIZE)

      for (const chunk of batch) {
        if (budgetLeft <= 0) break

        const prevChunk: Chunk | null = allChunks[allChunks.indexOf(chunk) - 1] ?? null

        // Load associated images for multimodal card generation
        // Try local disk first (from chunking phase), fall back to Supabase
        const chunkImgs = await db
          .select()
          .from(chunkImages)
          .where(eq(chunkImages.chunkId, chunk.id))
          .orderBy(chunkImages.position)

        let images: { base64: string; mimeType: string; alt: string }[] | undefined
        if (chunkImgs.length > 0) {
          images = []
          for (const img of chunkImgs) {
            try {
              // Try local file first (avoids Supabase egress)
              const filename = basename(img.storagePath)
              const localPath = `${imageDir}/${filename}`
              let buffer: Buffer
              try {
                buffer = await readFile(localPath)
              } catch {
                // Not on disk — download from Supabase
                buffer = await downloadDocument(img.storagePath)
              }
              images.push({
                base64: buffer.toString('base64'),
                mimeType: img.mimeType,
                alt: img.altText ?? '',
              })
            } catch {
              // Image load failed — skip
            }
          }
          if (images.length === 0) images = undefined
        }

        const { cards: newCards, usage: cardUsage } = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider, cardTypes, images)
        attempted.add(chunk.id)

        if (cardUsage) {
          logUsage(doc.userId, doc.id, 'card_generation', provider.name, provider.model, cardUsage, chunk.id)
        }

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
        ...(doc.retryCount ? { retryCount: 0 } : {}),
      })
      .where(eq(documents.id, doc.id))

    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId))

    if (allDone) {
      console.log(`[pipeline] done: doc=${doc.id} cards=${docCardCount?.count}`)
    } else {
      console.log(`[pipeline] progress: doc=${doc.id} cards=${docCardCount?.count}, pending=${stillPending.length}`)
    }

    // Clean up temp image directory now that card generation is done
    await rm(imageDir, { recursive: true, force: true }).catch(() => {})

    return cardsGenerated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const retryCount = (doc.retryCount ?? 0) + 1

    if (isTransient(err) && retryCount < MAX_RETRIES) {
      // Transient: keep doc in current status so next cron retries it
      console.warn(`[pipeline] transient error (attempt ${retryCount}/${MAX_RETRIES}): doc=${doc.id} ${message}`)
      await db.update(documents).set({ retryCount }).where(eq(documents.id, doc.id))
      await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
      captureException(err, doc.userId, { documentId: doc.id, retryCount, transient: true })
    } else {
      // Permanent error or retries exhausted
      console.error(`[pipeline] permanent error: doc=${doc.id}`, err)
      await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
      await db.update(documents).set({ processingStatus: 'error', retryCount }).where(eq(documents.id, doc.id))
      captureException(err, doc.userId, { documentId: doc.id, retryCount, transient: false })
    }
    await unlink(tmpPath).catch(() => {})
    await rm(imageDir, { recursive: true, force: true }).catch(() => {})
    return 0
  }
}

// ── Per-user entry point (Document-level VTRR) ──────────────

/**
 * Process active documents for a user using Virtual Time Round Robin.
 * The oldest document (priority) has a higher weight (3x) so its virtual
 * clock advances slower → it gets picked more often.
 *
 * Returns the number of cards generated in this run.
 */
export async function processUser(userId: string, tier: Tier): Promise<number> {
  const acquired = await tryAcquireUserLock(userId)
  if (!acquired) {
    console.log(`[pipeline] user=${userId} already being processed, skipping`)
    return 0
  }

  try {
    return await _processUser(userId, tier)
  } finally {
    await releaseUserLock(userId)
  }
}

async function _processUser(userId: string, tier: Tier): Promise<number> {
  const dailyLimit = TIER_LIMITS[tier].cardsPerDay
  const alreadyToday = await cardsGeneratedToday(userId)
  let budget = dailyLimit - alreadyToday

  if (budget <= 0) {
    console.log(`[pipeline] user=${userId} daily card limit reached (${dailyLimit})`)
    return 0
  }

  const staleThreshold = new Date(Date.now() - LOCK_EXPIRY_MS)

  // Fetch active documents that are not locked by another machine and not paused
  const activeDocs = await db
    .select()
    .from(documents)
    .where(and(
      eq(documents.userId, userId),
      inArray(documents.processingStatus, ['chunking', 'generating']),
      eq(documents.paused, false),
      or(
        isNull(documents.lockedBy),
        eq(documents.lockedBy, MACHINE_ID),
        lt(documents.lockedAt, staleThreshold),
      ),
    ))
    .orderBy(asc(documents.docVirtualTime))

  if (activeDocs.length === 0) return 0

  // Priority doc = pinned > active > normal, then oldest by createdAt
  const PRIORITY_RANK: Record<string, number> = { pinned: 0, active: 1, normal: 2 }
  const priorityDocId = activeDocs.reduce((best, doc) => {
    const bestRank = PRIORITY_RANK[best.priority] ?? 2
    const docRank = PRIORITY_RANK[doc.priority] ?? 2
    if (docRank < bestRank) return doc
    if (docRank === bestRank && doc.createdAt! < best.createdAt!) return doc
    return best
  }).id

  let totalGenerated = 0
  const exhausted = new Set<string>()

  while (budget > 0) {
    // Pick doc with lowest virtualTime that isn't exhausted
    const candidates = activeDocs
      .filter((d) => !exhausted.has(d.id))
      .sort((a, b) => {
        const vtDiff = (a.docVirtualTime ?? 0) - (b.docVirtualTime ?? 0)
        if (vtDiff !== 0) return vtDiff
        // Tie-break: prefer docs we have affinity with
        const aAff = hasAffinity(a.id) ? 0 : 1
        const bAff = hasAffinity(b.id) ? 0 : 1
        return aAff - bAff
      })

    if (candidates.length === 0) break

    const doc = candidates[0]
    const batchBudget = Math.min(budget, CARDS_PER_BATCH)

    const locked = await acquireLock(doc.id)
    if (!locked) {
      exhausted.add(doc.id)
      continue
    }

    try {
      const generated = await processDocument(doc, batchBudget)

      if (generated === 0) {
        exhausted.add(doc.id)
      } else {
        // Log usage event — survives document deletion, used for daily limit enforcement.
        // Must be awaited so concurrent processUser calls see an accurate daily count.
        await db.insert(usageEvents).values({
          userId,
          eventType: 'cards_generated',
          quantity: generated,
          documentId: doc.id,
        }).catch((err) => console.warn('[usage-event] failed to log cards_generated:', err))

        const weight = getDocWeight(doc.id, priorityDocId)
        const newVt = (doc.docVirtualTime ?? 0) + generated / weight
        doc.docVirtualTime = newVt

        await db
          .update(documents)
          .set({ docVirtualTime: newVt })
          .where(eq(documents.id, doc.id))

        totalGenerated += generated
        budget -= generated
      }

      addAffinity(doc.id)
    } catch (err) {
      console.error(`[pipeline] error processing doc=${doc.id}:`, err)
      exhausted.add(doc.id)
    } finally {
      await releaseLock(doc.id)
    }
  }

  return totalGenerated
}

// ── Cron entry point (User-level VTRR) ──────────────────────

/**
 * Main cron handler — runs every 15 minutes.
 *
 * Uses Virtual Time Round Robin across users. Plus-tier users have a
 * higher weight (2x) so their virtual clock advances slower → they get
 * processed more often. Users who got 0 processing last run have the
 * lowest virtualTime → automatically boosted.
 */
export async function processCron(): Promise<void> {
  // Fetch users with active documents, joined with their tier + virtualTime
  const usersWithWork = await db
    .selectDistinct({
      userId: documents.userId,
      tier: profiles.tier,
      virtualTime: profiles.virtualTime,
    })
    .from(documents)
    .innerJoin(profiles, eq(profiles.id, documents.userId))
    .where(inArray(documents.processingStatus, ['chunking', 'generating']))

  if (usersWithWork.length === 0) return

  const users = usersWithWork.map((u) => ({
    ...u,
    tier: (u.tier ?? 'free') as Tier,
    virtualTime: u.virtualTime ?? 0,
    exhausted: false,
  }))

  let anyProgress = true

  while (anyProgress) {
    anyProgress = false

    // Pick user with lowest virtualTime that isn't exhausted
    const candidates = users
      .filter((u) => !u.exhausted)
      .sort((a, b) => a.virtualTime - b.virtualTime)

    if (candidates.length === 0) break

    const user = candidates[0]

    try {
      const generated = await processUser(user.userId, user.tier)

      if (generated === 0) {
        user.exhausted = true
        anyProgress = users.some((u) => !u.exhausted)
      } else {
        anyProgress = true
        const weight = TIER_WEIGHTS[user.tier] ?? 1
        user.virtualTime += generated / weight

        await db
          .update(profiles)
          .set({ virtualTime: user.virtualTime })
          .where(eq(profiles.id, user.userId))
      }
    } catch (err) {
      console.error(`[cron] error for user=${user.userId}:`, err)
      user.exhausted = true
      anyProgress = users.some((u) => !u.exhausted)
    }
  }

  // Virtual time normalization — prevent overflow
  const minVt = Math.min(...users.map((u) => u.virtualTime))
  if (minVt > 10000) {
    await db
      .update(profiles)
      .set({ virtualTime: sql`${profiles.virtualTime} - ${minVt}` })
      .where(inArray(profiles.id, users.map((u) => u.userId)))
  }

  cleanAffinity()
  await releaseAllMyLocks()
}
