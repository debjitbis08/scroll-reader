import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents, profiles, aiUsageLogs } from '@scroll-reader/db'
import type { DocumentType, ReadingGoal, Tier } from '@scroll-reader/shared-types'
import { classifyToc } from '@scroll-reader/pipeline'
import type { TocEntry } from '@scroll-reader/pipeline'
import { processUser } from '../../../../lib/pipeline.ts'
import { createProvider } from '../../../../lib/ai/index.ts'

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
  const { pageStart, pageEnd, documentType, readingGoal, selectedTocIndices } = body as {
    pageStart: number
    pageEnd: number
    documentType?: string
    readingGoal?: string
    selectedTocIndices?: number[]
  }

  if (
    typeof pageStart !== 'number' || typeof pageEnd !== 'number' ||
    pageStart < 1 || pageEnd < pageStart ||
    (doc.totalPages && pageEnd > doc.totalPages)
  ) {
    return new Response('Invalid page range', { status: 400 })
  }

  // Validate selectedTocIndices if provided
  const tocLength = Array.isArray(doc.toc) ? doc.toc.length : 0
  if (selectedTocIndices !== undefined) {
    if (!Array.isArray(selectedTocIndices) || selectedTocIndices.some(
      (i) => typeof i !== 'number' || i < 0 || i >= tocLength,
    )) {
      return new Response('Invalid TOC indices', { status: 400 })
    }
  }

  // Validate and resolve card strategy
  const docType: DocumentType = (documentType && VALID_DOC_TYPES.includes(documentType as DocumentType))
    ? documentType as DocumentType
    : 'other'
  const goal: ReadingGoal = (readingGoal && VALID_GOALS.includes(readingGoal as ReadingGoal))
    ? readingGoal as ReadingGoal
    : 'reflective'

  // Save page range, TOC selection, doc type, goal, and transition to chunking
  await db
    .update(documents)
    .set({
      pageStart,
      pageEnd,
      selectedTocIndices: selectedTocIndices ?? null,
      documentType: docType,
      readingGoal: goal,
      processingStatus: 'chunking',
    })
    .where(eq(documents.id, docId))

  // Fire first batch immediately so the user sees cards right away.
  // The cron handles the rest over subsequent runs.
  setImmediate(async () => {
    try {
      // Classify TOC entries as frontmatter/mainmatter/backmatter so the
      // pipeline can exempt frontmatter cards from the daily budget.
      const toc = doc.toc as TocEntry[] | null
      if (toc && toc.length > 0) {
        try {
          const provider = createProvider()
          const { classification, usage } = await classifyToc(toc, provider)
          await db.update(documents)
            .set({ tocClassification: classification })
            .where(eq(documents.id, docId))

          if (usage) {
            db.insert(aiUsageLogs).values({
              userId,
              documentId: docId,
              operation: 'chunking',
              provider: provider.name,
              model: provider.model,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              durationMs: usage.durationMs,
              metadata: usage.raw ?? null,
            }).catch((err) => console.warn('[configure] failed to log classify-toc usage:', err))
          }
        } catch (err) {
          console.warn('[configure] TOC classification failed, continuing without:', err)
        }
      }

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
