import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents } from '@scroll-reader/db'

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const userId = locals.user.id
  const docId = params.id!

  const body = await request.json().catch(() => null)
  if (!body || typeof body.paused !== 'boolean') {
    return new Response('Invalid request', { status: 400 })
  }

  const [doc] = await db
    .select({ id: documents.id, processingStatus: documents.processingStatus })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
    .limit(1)

  if (!doc) return new Response('Not found', { status: 404 })

  // Only allow pause/resume on documents that are still processing
  if (doc.processingStatus !== 'chunking' && doc.processingStatus !== 'generating') {
    return new Response('Document is not currently processing', { status: 400 })
  }

  await db
    .update(documents)
    .set({ paused: body.paused })
    .where(eq(documents.id, docId))

  return new Response(null, { status: 204 })
}
