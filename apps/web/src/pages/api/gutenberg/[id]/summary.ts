import type { APIRoute } from 'astro'
import { fetchGutendexExtras } from '../../../../lib/gutenberg-meta.ts'

// Separate from /api/gutenberg/[id] because Gutendex is slow: the details modal
// renders local catalog metadata immediately and fills the summary in later.
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  const gutenbergId = parseInt(params.id!, 10)
  if (isNaN(gutenbergId)) return new Response('Invalid ID', { status: 400 })

  const extras = await fetchGutendexExtras(gutenbergId)
  return Response.json(extras, {
    headers: { 'Cache-Control': extras.summary ? 'private, max-age=86400' : 'no-store' },
  })
}
