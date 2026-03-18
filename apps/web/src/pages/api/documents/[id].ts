import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { documents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const DELETE: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const docId = params.id!

  // Verify ownership then delete — cascades handle chunks, cards, jobs
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, user.id)))
    .limit(1)

  if (!doc) return new Response(null, { status: 404 })

  await db.delete(documents).where(eq(documents.id, docId))

  return new Response(null, { status: 204 })
}
