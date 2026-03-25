import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents, profiles } from '@scroll-reader/db'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import type { DocumentType, ReadingGoal, Tier } from '@scroll-reader/shared-types'
import { processUser } from '../../../../lib/pipeline.ts'

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

  // Fire first batch immediately so the user sees cards right away.
  // The cron handles the rest over subsequent runs.
  setImmediate(async () => {
    try {
      const [profile] = await db
        .select({ tier: profiles.tier })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)

      const tier = (profile?.tier ?? 'free') as Tier
      await processUser(userId, tier)
    } catch (err) {
      console.error('[configure] background processing error:', err)
    }
  })

  return new Response('OK', { status: 200 })
}
