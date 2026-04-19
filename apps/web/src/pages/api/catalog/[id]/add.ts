import type { APIRoute } from 'astro'
import { eq, and, inArray } from 'drizzle-orm'
import { writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../../../../lib/db.ts'
import { documents, chunks, cards, jobs, catalogBooks, catalogChunks, catalogCards } from '@scroll-reader/db'
import type { CardType, DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import { getPageCount, extractToc } from '@scroll-reader/pipeline'
import { uploadDocument } from '../../../../lib/storage.ts'
import { EXTRACTOR_BIN } from 'astro:env/server'
import { processCatalogBook } from '../../../../lib/catalog-pipeline.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const extractConfig = {
  extractorBin: EXTRACTOR_BIN || join(HERE, '../../../../../../packages/extractor/target/debug/extractor'),
}

const VALID_DOC_TYPES: DocumentType[] = ['book', 'paper', 'article', 'manual', 'note', 'scripture', 'other', 'fiction']
const VALID_GOALS: ReadingGoal[] = ['casual', 'reflective', 'study']

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const userId = locals.user.id
  const gutenbergIdParam = params.id!

  // This endpoint accepts either a catalog book UUID or a Gutenberg ID (numeric)
  const isGutenbergId = /^\d+$/.test(gutenbergIdParam)

  const body = await request.json()
  const { documentType, readingGoal, epubUrl, cardTypesOverride, chunkIntervalOverride } = body as {
    documentType?: string
    readingGoal?: string
    epubUrl?: string
    cardTypesOverride?: string[]
    chunkIntervalOverride?: number
  }

  const docType: DocumentType = (documentType && VALID_DOC_TYPES.includes(documentType as DocumentType))
    ? documentType as DocumentType : 'other'
  const goal: ReadingGoal = (readingGoal && VALID_GOALS.includes(readingGoal as ReadingGoal))
    ? readingGoal as ReadingGoal : 'reflective'

  // ── Resolve card strategy ──
  const VALID_CARD_TYPES: CardType[] = ['discover', 'connect', 'raw_commentary', 'flashcard', 'quiz', 'glossary', 'contrast', 'passage']
  const validatedCardTypes = cardTypesOverride && Array.isArray(cardTypesOverride) && cardTypesOverride.length > 0
    ? cardTypesOverride.filter((t): t is CardType => VALID_CARD_TYPES.includes(t as CardType))
    : null
  const validatedInterval = chunkIntervalOverride && typeof chunkIntervalOverride === 'number' && chunkIntervalOverride >= 1 && chunkIntervalOverride <= 5
    ? chunkIntervalOverride
    : null

  // ── Find catalog book ──
  let catalogBook
  if (isGutenbergId) {
    const gutenbergId = parseInt(gutenbergIdParam, 10)
    const [existing] = await db.select().from(catalogBooks)
      .where(eq(catalogBooks.gutenbergId, gutenbergId)).limit(1)
    catalogBook = existing ?? null
  } else {
    const [existing] = await db.select().from(catalogBooks)
      .where(eq(catalogBooks.id, gutenbergIdParam)).limit(1)
    if (!existing) return new Response('Catalog book not found', { status: 404 })
    catalogBook = existing
  }

  // ── If catalog book is ready, use the fast cached path ──
  if (catalogBook?.processingStatus === 'ready') {
    return addFromCache(userId, catalogBook, docType, goal, validatedCardTypes, validatedInterval)
  }

  // ── Dedup check (for catalog books still processing or uncached) ──
  if (catalogBook) {
    const [existingDoc] = await db.select({ id: documents.id }).from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.catalogBookId, catalogBook.id)))
      .limit(1)
    if (existingDoc) {
      return Response.json({ error: 'Book already in your library', documentId: existingDoc.id }, { status: 409 })
    }
  }

  // ── Uncached or still processing: download EPUB and treat like an upload ──
  if (!epubUrl) {
    return Response.json({ error: 'epubUrl required for uncached book' }, { status: 400 })
  }

  // Download EPUB from Gutenberg
  let buffer: Buffer
  try {
    const res = await fetch(epubUrl, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    buffer = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Download failed'
    return Response.json({ error: `Could not download book: ${msg}` }, { status: 502 })
  }

  // Extract page count + TOC (fast Rust extraction)
  const tmpPath = `/tmp/scroll-${crypto.randomUUID()}.epub`
  let totalPages = 1
  let toc: { title: string; page: number; level: number; fragment?: string }[] = []
  try {
    await writeFile(tmpPath, buffer)
    const [pageCount, tocEntries] = await Promise.all([
      getPageCount(tmpPath, extractConfig),
      extractToc(tmpPath, extractConfig),
    ])
    totalPages = pageCount
    toc = tocEntries
  } catch (err) {
    console.error('[catalog/add] preview extraction failed:', err)
  } finally {
    await unlink(tmpPath).catch(() => {})
  }

  // Create or find catalog book entry (for future caching, but don't block on it)
  let catalogBookId: string | null = catalogBook?.id ?? null
  if (!catalogBook && isGutenbergId) {
    const gutenbergId = parseInt(gutenbergIdParam, 10)
    const [newBook] = await db.insert(catalogBooks).values({
      gutenbergId,
      title: body.title ?? 'Untitled',
      author: body.author ?? null,
      subjects: body.subjects ?? null,
      languages: body.languages ?? ['en'],
      coverImageUrl: body.coverUrl ?? null,
      totalPages,
      toc: toc.length > 0 ? toc : null,
      processingStatus: 'pending',
    }).returning()
    catalogBookId = newBook.id

    // Kick off catalog processing in background (for future users)
    setImmediate(() => {
      processCatalogBook(newBook.id, epubUrl).catch((err) => {
        console.error('[catalog/add] background catalog processing error:', err)
      })
    })
  }

  // Create document — same as upload flow, but skip 'preview' since config is done
  const [doc] = await db
    .insert(documents)
    .values({
      userId,
      title: body.title ?? 'Untitled',
      author: body.author ?? null,
      documentType: docType,
      readingGoal: goal,
      cardTypesOverride: validatedCardTypes,
      chunkIntervalOverride: validatedInterval,
      source: 'catalog',
      catalogBookId: catalogBookId,
      filePath: '',
      fileSize: buffer.length,
      processingStatus: 'chunking',
      totalPages,
      pageStart: 1,
      pageEnd: totalPages,
      toc: toc.length > 0 ? toc : null,
    })
    .returning()

  // Upload to Supabase Storage
  try {
    const path = await uploadDocument(userId, doc.id, '.epub', buffer)
    await db.update(documents).set({ filePath: path }).where(eq(documents.id, doc.id))
  } catch (err) {
    console.error('[catalog/add] storage upload failed:', err)
    await db.delete(documents).where(eq(documents.id, doc.id))
    return Response.json({ error: 'Could not store document' }, { status: 500 })
  }

  // Create job row for polling
  await db.insert(jobs).values({ userId, documentId: doc.id })

  return Response.json({ documentId: doc.id, status: 'processing' })
}

// ── Fast path: copy pre-processed chunks and cards from catalog cache ──

async function addFromCache(
  userId: string,
  catalogBook: typeof catalogBooks.$inferSelect,
  docType: DocumentType,
  goal: ReadingGoal,
  validatedCardTypes: CardType[] | null,
  validatedInterval: number | null,
) {
  // Dedup check
  const [existingDoc] = await db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.catalogBookId, catalogBook.id)))
    .limit(1)
  if (existingDoc) {
    return Response.json({ error: 'Book already in your library', documentId: existingDoc.id }, { status: 409 })
  }

  const baseStrategy = resolveCardStrategy(docType, goal)
  const cardTypes = validatedCardTypes ?? baseStrategy.cardTypes
  const chunkInterval = validatedInterval ?? baseStrategy.chunkInterval

  // Fetch catalog chunks
  const allCatalogChunks = await db.select().from(catalogChunks)
    .where(eq(catalogChunks.catalogBookId, catalogBook.id))
    .orderBy(catalogChunks.chunkIndex)

  // Apply chunkInterval to text/code chunks
  const textCodeChunks = allCatalogChunks.filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
  const eligibleChunks = chunkInterval > 1
    ? textCodeChunks.filter((_, i) => i % chunkInterval === 0)
    : textCodeChunks
  const eligibleChunkIds = new Set(eligibleChunks.map((c) => c.id))

  // Create user document
  const [newDoc] = await db.insert(documents).values({
    userId,
    title: catalogBook.title,
    author: catalogBook.author,
    documentType: docType,
    readingGoal: goal,
    cardTypesOverride: validatedCardTypes,
    chunkIntervalOverride: validatedInterval,
    source: 'catalog',
    catalogBookId: catalogBook.id,
    processingStatus: 'generating', // will be updated to 'ready' if fully cached
    totalPages: catalogBook.totalPages,
    totalElements: allCatalogChunks.length,
    elementsProcessed: allCatalogChunks.length,
    chunkCount: eligibleChunks.length,
    toc: catalogBook.toc,
    tocClassification: catalogBook.tocClassification,
  }).returning()

  // Copy chunks
  const chunkIdMap = new Map<string, string>()
  const BATCH = 500

  for (let i = 0; i < eligibleChunks.length; i += BATCH) {
    const batch = eligibleChunks.slice(i, i + BATCH)
    const inserted = await db.insert(chunks).values(batch.map((c, j) => ({
      userId,
      documentId: newDoc.id,
      chunkType: c.chunkType,
      content: c.content,
      chunkIndex: i + j,
      chapter: c.chapter ?? undefined,
      wordCount: c.wordCount ?? undefined,
      language: c.language ?? 'en',
      encrypted: false,
      catalogChunkId: c.id,
    }))).returning({ id: chunks.id })

    for (let j = 0; j < batch.length; j++) {
      chunkIdMap.set(batch[j].id, inserted[j].id)
    }
  }

  // Copy cached cards
  const eligibleIds = Array.from(eligibleChunkIds)
  let totalCardsCopied = 0

  for (let i = 0; i < eligibleIds.length; i += BATCH) {
    const batchIds = eligibleIds.slice(i, i + BATCH)
    const catCards = await db.select().from(catalogCards)
      .where(and(
        inArray(catalogCards.catalogChunkId, batchIds),
        inArray(catalogCards.cardType, cardTypes as string[]),
      ))

    if (catCards.length === 0) continue

    const cardRows = catCards
      .filter((c) => chunkIdMap.has(c.catalogChunkId))
      .map((c) => ({
        userId,
        chunkId: chunkIdMap.get(c.catalogChunkId)!,
        cardType: c.cardType,
        content: c.content,
        encrypted: false,
        aiProvider: c.aiProvider ?? undefined,
        aiModel: c.aiModel ?? undefined,
      }))

    for (let j = 0; j < cardRows.length; j += BATCH) {
      await db.insert(cards).values(cardRows.slice(j, j + BATCH))
    }
    totalCardsCopied += cardRows.length
  }

  // Determine if all needed cards were served from cache
  const expectedCards = eligibleChunks.length * cardTypes.length
  const fullyCached = totalCardsCopied >= expectedCards

  await db.update(documents)
    .set({
      cardCount: totalCardsCopied,
      processingStatus: fullyCached ? 'ready' : 'generating',
    })
    .where(eq(documents.id, newDoc.id))

  return Response.json({
    documentId: newDoc.id,
    cardsCopied: totalCardsCopied,
    status: fullyCached ? 'ready' : 'generating',
  })
}
