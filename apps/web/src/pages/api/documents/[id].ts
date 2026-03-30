import type { APIRoute } from 'astro'
import { eq, and } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { documents } from '@scroll-reader/db'
import { createSupabaseServer } from '../../../lib/supabase.ts'
import { deleteDocument, deleteDocumentImages, downloadDocument } from '../../../lib/storage.ts'
import { extractToc } from '@scroll-reader/pipeline'
import { EXTRACTOR_BIN } from 'astro:env/server'
import { writeFile, unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const extractConfig = {
  extractorBin: EXTRACTOR_BIN || join(HERE, '../../../../packages/extractor/target/debug/extractor'),
}

export const PATCH: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const docId = params.id!
  const body = await request.json()

  const [doc] = await db
    .select({ id: documents.id, filePath: documents.filePath })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, user.id)))
    .limit(1)

  if (!doc) return new Response(null, { status: 404 })

  // Re-extract TOC from the stored file
  if (body.refreshToc) {
    if (!doc.filePath) {
      return new Response(JSON.stringify({ error: 'No file stored' }), { status: 400 })
    }
    const ext = extname(doc.filePath)
    const tmpPath = `/tmp/scroll-toc-${crypto.randomUUID()}${ext}`
    try {
      const buffer = await downloadDocument(doc.filePath)
      await writeFile(tmpPath, buffer)
      const toc = await extractToc(tmpPath, extractConfig)
      await db.update(documents).set({
        toc: toc.length > 0 ? toc : null,
      }).where(eq(documents.id, docId))
      return new Response(JSON.stringify({ toc }), { status: 200 })
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  }

  // Update title
  const title = typeof body.title === 'string' ? body.title.trim() : null
  if (!title) return new Response(JSON.stringify({ error: 'Title is required' }), { status: 400 })

  await db.update(documents).set({ title }).where(eq(documents.id, docId))

  return new Response(JSON.stringify({ title }), { status: 200 })
}

export const DELETE: APIRoute = async ({ params, request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(null, { status: 401 })

  const docId = params.id!

  // Verify ownership then delete — cascades handle chunks, cards, jobs
  const [doc] = await db
    .select({ id: documents.id, filePath: documents.filePath })
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.userId, user.id)))
    .limit(1)

  if (!doc) return new Response(null, { status: 404 })

  // Clean up storage: original file + extracted images
  if (doc.filePath) await deleteDocument(doc.filePath).catch(() => {})
  await deleteDocumentImages(user.id, docId).catch(() => {})

  await db.delete(documents).where(eq(documents.id, docId))

  return new Response(null, { status: 204 })
}
