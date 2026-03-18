import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents, jobs } from '@scroll-reader/db'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import type { DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { runPipeline } from '../../../../lib/pipeline.ts'

const VALID_DOC_TYPES: DocumentType[] = ['book', 'paper', 'article', 'manual', 'note', 'scripture', 'other', 'fiction']
const VALID_GOALS: ReadingGoal[] = ['casual', 'reflective', 'study']

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
  const { pageStart, pageEnd, documentType, readingGoal } = body as {
    pageStart: number
    pageEnd: number
    documentType?: string
    readingGoal?: string
  }

  if (
    typeof pageStart !== 'number' || typeof pageEnd !== 'number' ||
    pageStart < 1 || pageEnd < pageStart ||
    (doc.totalPages && pageEnd > doc.totalPages)
  ) {
    return new Response('Invalid page range', { status: 400 })
  }

  // Validate and resolve card strategy
  const docType: DocumentType = (documentType && VALID_DOC_TYPES.includes(documentType as DocumentType))
    ? documentType as DocumentType
    : 'other'
  const goal: ReadingGoal = (readingGoal && VALID_GOALS.includes(readingGoal as ReadingGoal))
    ? readingGoal as ReadingGoal
    : 'reflective'

  const cardStrategy = resolveCardStrategy(docType, goal)

  // Save page range, strategy, and transition to chunking
  await db
    .update(documents)
    .set({
      pageStart,
      pageEnd,
      documentType: docType,
      readingGoal: goal,
      cardStrategy,
      processingStatus: 'chunking',
    })
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
