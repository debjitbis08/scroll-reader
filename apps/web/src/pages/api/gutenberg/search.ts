import type { APIRoute } from 'astro'
import { eq, sql, inArray } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { gutenbergCatalog, catalogBooks } from '@scroll-reader/db'

export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const q = url.searchParams.get('q')?.trim()
  if (!q) return Response.json({ results: [], count: 0 })

  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 50)
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10)

  // Full-text search against local Gutenberg catalog
  const tsQuery = q.split(/\s+/).filter(Boolean).map((w) => w + ':*').join(' & ')

  const results = await db
    .select({
      gutenbergId: gutenbergCatalog.gutenbergId,
      title: gutenbergCatalog.title,
      author: gutenbergCatalog.author,
      subjects: gutenbergCatalog.subjects,
      bookshelves: gutenbergCatalog.bookshelves,
      language: gutenbergCatalog.language,
      rank: sql<number>`ts_rank(${gutenbergCatalog.searchVector}, to_tsquery('english', ${tsQuery}))`,
    })
    .from(gutenbergCatalog)
    .where(sql`${gutenbergCatalog.searchVector} @@ to_tsquery('english', ${tsQuery})`)
    .orderBy(sql`ts_rank(${gutenbergCatalog.searchVector}, to_tsquery('english', ${tsQuery})) DESC`)
    .limit(limit)
    .offset(offset)

  // Count total matches
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gutenbergCatalog)
    .where(sql`${gutenbergCatalog.searchVector} @@ to_tsquery('english', ${tsQuery})`)

  // Check which results are already cached in catalog_books
  const gutenbergIds = results.map((r) => r.gutenbergId)
  const cachedRows = gutenbergIds.length > 0
    ? await db
        .select({ gutenbergId: catalogBooks.gutenbergId, processingStatus: catalogBooks.processingStatus })
        .from(catalogBooks)
        .where(inArray(catalogBooks.gutenbergId, gutenbergIds))
    : []
  const cacheMap = new Map(cachedRows.map((r) => [r.gutenbergId, r.processingStatus]))

  return Response.json({
    results: results.map((r) => ({
      gutenbergId: r.gutenbergId,
      title: r.title,
      author: r.author,
      subjects: r.subjects?.split(';').map((s) => s.trim()).filter(Boolean) ?? [],
      bookshelves: r.bookshelves?.split(';').map((s) => s.trim()).filter(Boolean) ?? [],
      language: r.language,
      coverUrl: `https://www.gutenberg.org/cache/epub/${r.gutenbergId}/pg${r.gutenbergId}.cover.medium.jpg`,
      epubUrl: `https://www.gutenberg.org/cache/epub/${r.gutenbergId}/pg${r.gutenbergId}-images.epub`,
      cacheStatus: cacheMap.get(r.gutenbergId) ?? null,
    })),
    count: countRow?.count ?? 0,
    hasMore: offset + limit < (countRow?.count ?? 0),
  })
}
