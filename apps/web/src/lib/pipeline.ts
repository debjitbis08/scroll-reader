import { eq, and, or, sql, gte, lt, isNull, inArray, asc } from 'drizzle-orm'
import { readFile, writeFile, unlink, rm, mkdir } from 'node:fs/promises'
import { extname, basename } from 'node:path'
import { db } from './db.ts'
import { documents, chunks, chunkImages, cards, jobs, profiles } from '@scroll-reader/db'
import type { Document, Chunk } from '@scroll-reader/db'
import { extractDocument, filterByPageRange } from './extract.ts'
import type { ImageElement } from './extract.ts'
import { callSegmenter, callChunker } from './chunker.ts'
import { createProvider } from './ai/index.ts'
import { aiChunk } from './ai/chunk.ts'
import { generateCardsForChunk } from './cards/generate.ts'
import type { CardType, DocumentType, ReadingGoal, Tier } from '@scroll-reader/shared-types'
import { TIER_LIMITS, resolveCardStrategy } from '@scroll-reader/shared-types'
import { BATCH_SIZE } from 'astro:env/server'
import { downloadDocument, deleteDocument, uploadImage } from './storage.ts'
import { MACHINE_ID, addAffinity, hasAffinity, cleanAffinity } from './machine.ts'

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

      let elements = await extractDocument(tmpPath, imageDir)
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
            const segments = await callSegmenter(el.content)
            textChunks = await aiChunk(segments, provider)
          } catch (err) {
            console.warn(`[pipeline] AI chunking failed, falling back to mechanical:`, err)
            textChunks = await callChunker(el.content)
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
          for (let ci = 0; ci < pendingChunks.length; ci++) {
            const pending = pendingChunks[ci]
            if (!pending.images || pending.images.length === 0) continue

            const chunkId = insertedChunks[ci].id
            for (let pos = 0; pos < pending.images.length; pos++) {
              const img = pending.images[pos]
              try {
                const buffer = await readFile(img.file)
                const filename = basename(img.file)
                const storagePath = await uploadImage(doc.userId, doc.id, filename, buffer, img.mime)
                await db.insert(chunkImages).values({
                  chunkId,
                  storagePath,
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

        const newCards = await generateCardsForChunk(chunk, prevChunk, doc as Document, provider, cardTypes, images)
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

    // Clean up temp image directory now that card generation is done
    await rm(imageDir, { recursive: true, force: true }).catch(() => {})

    return cardsGenerated
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[pipeline] error: doc=${doc.id}`, err)
    await db.update(jobs).set({ status: 'failed', error: message, finishedAt: new Date() }).where(eq(jobs.id, jobId))
    await db.update(documents).set({ processingStatus: 'error' }).where(eq(documents.id, doc.id))
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
