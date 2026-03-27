import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../../lib/db.ts'
import { documents } from '@scroll-reader/db'
import type { DocumentPriority } from '@scroll-reader/shared-types'

const VALID_PRIORITIES: DocumentPriority[] = ['pinned', 'active', 'normal']

export const POST: APIRoute = async ({ request, locals, params }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const userId = locals.user.id
  const docId = params.id!

  const body = await request.json().catch(() => null)
  if (!body || !VALID_PRIORITIES.includes(body.priority)) {
    return new Response('Invalid priority', { status: 400 })
  }

  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, userId)))
    .limit(1)

  if (!doc) return new Response('Not found', { status: 404 })

  await db
    .update(documents)
    .set({ priority: body.priority })
    .where(eq(documents.id, docId))

  return new Response(null, { status: 204 })
}
