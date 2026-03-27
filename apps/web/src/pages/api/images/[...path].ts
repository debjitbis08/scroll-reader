import type { APIRoute } from 'astro'
import { downloadDocument } from '../../../lib/storage.ts'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

/**
 * Image proxy — downloads from Supabase storage and serves with
 * Cache-Control headers so Fly.io and the browser cache the result.
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
    const buffer = await downloadDocument(storagePath)
    const ext = storagePath.substring(storagePath.lastIndexOf('.'))
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=86400',
        'ETag': `"${storagePath}"`,
      },
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}
