import type { APIRoute } from 'astro'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents, chunks, cards, catalogBooks, catalogChunks, catalogCards } from '@scroll-reader/db'
import type { CardType, DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import { processCatalogBook } from '../../../../lib/catalog-pipeline.ts'

const VALID_DOC_TYPES: DocumentType[] = ['book', 'paper', 'article', 'manual', 'note', 'scripture', 'other', 'fiction']
const VALID_GOALS: ReadingGoal[] = ['casual', 'reflective', 'study']

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const userId = locals.user.id
  const gutenbergIdParam = params.id!

  // This endpoint accepts either a catalog book UUID or a Gutenberg ID (numeric)
  const isGutenbergId = /^\d+$/.test(gutenbergIdParam)

  const body = await request.json()
  const { documentType, readingGoal, epubUrl } = body as {
    documentType?: string
    readingGoal?: string
    epubUrl?: string
  }

  const docType: DocumentType = (documentType && VALID_DOC_TYPES.includes(documentType as DocumentType))
    ? documentType as DocumentType : 'other'
  const goal: ReadingGoal = (readingGoal && VALID_GOALS.includes(readingGoal as ReadingGoal))
    ? readingGoal as ReadingGoal : 'reflective'

  // ── Find or create catalog book ──
  let catalogBook
  if (isGutenbergId) {
    const gutenbergId = parseInt(gutenbergIdParam, 10)
    const [existing] = await db.select().from(catalogBooks)
      .where(eq(catalogBooks.gutenbergId, gutenbergId)).limit(1)

    if (existing) {
      catalogBook = existing
    } else {
      // Cache miss — need to process this book
      if (!epubUrl) {
        return Response.json({ error: 'epubUrl required for uncached book' }, { status: 400 })
      }

      // Create catalog entry and kick off processing
      const [newBook] = await db.insert(catalogBooks).values({
        gutenbergId,
        title: body.title ?? 'Untitled',
        author: body.author ?? null,
        subjects: body.subjects ?? null,
        languages: body.languages ?? ['en'],
        coverImageUrl: body.coverUrl ?? null,
        processingStatus: 'pending',
      }).returning()

      // Start processing in background
      setImmediate(() => {
        processCatalogBook(newBook.id, epubUrl).catch((err) => {
          console.error('[catalog/add] background processing error:', err)
        })
      })

      return Response.json({
        status: 'processing',
        catalogBookId: newBook.id,
      }, { status: 202 })
    }
  } else {
    // Direct catalog book ID
    const [existing] = await db.select().from(catalogBooks)
      .where(eq(catalogBooks.id, gutenbergIdParam)).limit(1)
    if (!existing) return new Response('Catalog book not found', { status: 404 })
    catalogBook = existing
  }

  // If still processing, return status
  if (catalogBook.processingStatus !== 'ready') {
    return Response.json({
      status: catalogBook.processingStatus === 'error' ? 'error' : 'processing',
      catalogBookId: catalogBook.id,
      error: catalogBook.error ?? undefined,
    }, { status: catalogBook.processingStatus === 'error' ? 500 : 202 })
  }

  // ── Dedup check ──
  const [existingDoc] = await db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.catalogBookId, catalogBook.id)))
    .limit(1)
  if (existingDoc) {
    return Response.json({ error: 'Book already in your library', documentId: existingDoc.id }, { status: 409 })
  }

  // ── Resolve strategy ──
  const { cardTypes, chunkInterval } = resolveCardStrategy(docType, goal)

  // ── Fetch catalog chunks ──
  const allCatalogChunks = await db.select().from(catalogChunks)
    .where(eq(catalogChunks.catalogBookId, catalogBook.id))
    .orderBy(catalogChunks.chunkIndex)

  // Apply chunkInterval to text/code chunks
  const textCodeChunks = allCatalogChunks.filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
  const eligibleChunks = chunkInterval > 1
    ? textCodeChunks.filter((_, i) => i % chunkInterval === 0)
    : textCodeChunks
  const eligibleChunkIds = new Set(eligibleChunks.map((c) => c.id))

  // ── Create user document ──
  const [newDoc] = await db.insert(documents).values({
    userId,
    title: catalogBook.title,
    author: catalogBook.author,
    documentType: docType,
    readingGoal: goal,
    source: 'catalog',
    catalogBookId: catalogBook.id,
    processingStatus: 'ready',
    totalPages: catalogBook.totalPages,
    totalElements: allCatalogChunks.length,
    elementsProcessed: allCatalogChunks.length,
    chunkCount: eligibleChunks.length,
    toc: catalogBook.toc,
    tocClassification: catalogBook.tocClassification,
  }).returning()

  // ── Copy chunks ──
  // Map catalogChunkId → new user chunkId
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
    }))).returning({ id: chunks.id })

    for (let j = 0; j < batch.length; j++) {
      chunkIdMap.set(batch[j].id, inserted[j].id)
    }
  }

  // ── Copy cards (only matching card types) ──
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

  // Update card count
  await db.update(documents)
    .set({ cardCount: totalCardsCopied })
    .where(eq(documents.id, newDoc.id))

  return Response.json({ documentId: newDoc.id, cardsCopied: totalCardsCopied })
}
