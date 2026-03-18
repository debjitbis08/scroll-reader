import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents, jobs } from '@scroll-reader/db'
import { runPipeline } from '../../../../lib/pipeline.ts'

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const userId = locals.user.id
  const docId = params.id!

  // Verify ownership and that doc is in preview state
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
    .limit(1)

  if (!doc) return new Response('Not found', { status: 404 })
  if (doc.processingStatus !== 'preview') {
    return new Response('Document is not in preview state', { status: 400 })
  }

  const body = await request.json()
  const { pageStart, pageEnd } = body as { pageStart: number; pageEnd: number }

  if (
    typeof pageStart !== 'number' || typeof pageEnd !== 'number' ||
    pageStart < 1 || pageEnd < pageStart ||
    (doc.totalPages && pageEnd > doc.totalPages)
  ) {
    return new Response('Invalid page range', { status: 400 })
  }

  // Save page range and transition to chunking
  await db
    .update(documents)
    .set({ pageStart, pageEnd, processingStatus: 'chunking' })
    .where(eq(documents.id, docId))

  // Get the existing job row
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.documentId, docId), eq(jobs.userId, userId)))
    .orderBy(jobs.createdAt)
    .limit(1)

  const jobId = job?.id ?? (
    await db.insert(jobs).values({ userId, documentId: docId }).returning()
  )[0].id

  // Fire pipeline in background
  setImmediate(() => {
    runPipeline(jobId, doc.filePath!, userId, docId).catch((err) => {
      console.error('[configure] unhandled pipeline error:', err)
    })
  })

  return new Response('OK', { status: 200 })
}
