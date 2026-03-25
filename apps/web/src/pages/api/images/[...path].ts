import type { APIRoute } from 'astro'
import { getImageSignedUrl } from '../../../lib/storage.ts'

/**
 * Generates a signed URL for a stored image and redirects to it.
 * This avoids exposing the Supabase service role key to the client.
 *
 * GET /api/images/{userId}/{documentId}/images/{filename}
 */
export const GET: APIRoute = async ({ params, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 })

  const storagePath = params.path
  if (!storagePath) return new Response(null, { status: 400 })

  // Verify the path belongs to the current user
  if (!storagePath.startsWith(locals.user.id)) {
    return new Response(null, { status: 403 })
  }

  try {
    const url = await getImageSignedUrl(storagePath)
    return Response.redirect(url, 302)
  } catch {
    return new Response(null, { status: 404 })
  }
}
