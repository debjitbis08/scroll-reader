import type { APIRoute } from 'astro'
import { eq } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { catalogBooks } from '@scroll-reader/db'

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const id = params.id!

  // Support both catalog book UUID and gutenberg ID
  const isGutenbergId = /^\d+$/.test(id)

  const [book] = isGutenbergId
    ? await db.select().from(catalogBooks)
        .where(eq(catalogBooks.gutenbergId, parseInt(id, 10))).limit(1)
    : await db.select().from(catalogBooks)
        .where(eq(catalogBooks.id, id)).limit(1)

  if (!book) return new Response('Not found', { status: 404 })

  return Response.json({
    catalogBookId: book.id,
    status: book.processingStatus,
    totalChunks: book.totalChunks,
    totalCards: book.totalCards,
    error: book.error ?? null,
  })
}
