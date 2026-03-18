import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { jobs } from '@scroll-reader/db'

export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, params.id!), eq(jobs.userId, locals.user.id)))
    .limit(1)

  if (!job) return new Response('Not found', { status: 404 })

  return Response.json(job)
}
