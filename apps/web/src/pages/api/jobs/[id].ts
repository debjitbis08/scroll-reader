import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { jobs, documents } from '@scroll-reader/db'

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, params.id!), eq(jobs.userId, locals.user.id)))
    .limit(1)

  if (!job) return new Response('Not found', { status: 404 })

  // Include doc status so frontend can distinguish transient (retrying) from permanent errors
  const [doc] = await db
    .select({ processingStatus: documents.processingStatus, retryCount: documents.retryCount })
    .from(documents)
    .where(eq(documents.id, job.documentId))
    .limit(1)

  return Response.json({
    ...job,
    docProcessingStatus: doc?.processingStatus ?? null,
    retryCount: doc?.retryCount ?? 0,
  })
}
