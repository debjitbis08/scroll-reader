import type { APIRoute } from 'astro'
import { eq } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { gutenbergCatalog, catalogBooks } from '@scroll-reader/db'

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const gutenbergId = parseInt(params.id!, 10)
  if (isNaN(gutenbergId)) return new Response('Invalid ID', { status: 400 })

  // Read from local catalog
  const [book] = await db
    .select()
    .from(gutenbergCatalog)
    .where(eq(gutenbergCatalog.gutenbergId, gutenbergId))
    .limit(1)

  if (!book) return new Response('Book not found', { status: 404 })

  // Check our processing cache
  const [cached] = await db
    .select({
      id: catalogBooks.id,
      processingStatus: catalogBooks.processingStatus,
      toc: catalogBooks.toc,
      totalChunks: catalogBooks.totalChunks,
      totalCards: catalogBooks.totalCards,
    })
    .from(catalogBooks)
    .where(eq(catalogBooks.gutenbergId, gutenbergId))
    .limit(1)

  return Response.json({
    gutenbergId,
    title: book.title,
    author: book.author,
    subjects: book.subjects?.split(';').map((s) => s.trim()).filter(Boolean) ?? [],
    language: book.language,
    coverUrl: `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}.cover.medium.jpg`,
    epubUrl: `https://www.gutenberg.org/cache/epub/${gutenbergId}/pg${gutenbergId}-images.epub`,
    cached: cached?.processingStatus === 'ready',
    cacheStatus: cached?.processingStatus ?? null,
    catalogBookId: cached?.id ?? null,
    toc: cached?.toc ?? null,
    totalChunks: cached?.totalChunks ?? null,
    totalCards: cached?.totalCards ?? null,
  })
}
