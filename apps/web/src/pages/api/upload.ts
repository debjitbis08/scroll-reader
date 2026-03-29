import type { APIRoute } from 'astro'
import { writeFile, unlink } from 'node:fs/promises'
import { extname } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { documents, profiles, jobs } from '@scroll-reader/db'
import { getPageCount, extractToc } from '../../lib/extract.ts'
import { uploadDocument } from '../../lib/storage.ts'
import { TIER_LIMITS } from '@scroll-reader/shared-types'
import type { Tier } from '@scroll-reader/shared-types'

const ALLOWED_EXTS = new Set(['.epub', '.pdf', '.txt'])
const MAX_BYTES = 100 * 1024 * 1024 // 100 MB

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!locals.user) return new Response('Unauthorized', { status: 401 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return redirect('/upload?error=Invalid+form+data')
  }

  const file = formData.get('file')
  const privacy = formData.get('privacy_acknowledged') === 'true'

  if (!(file instanceof File)) return redirect('/upload?error=No+file+selected')
  if (!privacy) return redirect('/upload?error=Privacy+acknowledgment+required')

  const ext = extname(file.name).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    return redirect('/upload?error=Only+EPUB%2C+PDF+and+TXT+files+are+supported')
  }
  if (file.size > MAX_BYTES) {
    return redirect('/upload?error=File+too+large+%28max+100+MB%29')
  }

  const userId = locals.user.id

  // Check storage quota
  const [profile] = await db
    .select({ tier: profiles.tier })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1)

  const tier = (profile?.tier ?? 'free') as Tier
  const limit = TIER_LIMITS[tier].storageBytes

  const [usage] = await db
    .select({ total: sql<number>`coalesce(sum(file_size), 0)::int` })
    .from(documents)
    .where(eq(documents.userId, userId))

  if ((usage?.total ?? 0) + file.size > limit) {
    const limitMB = Math.round(limit / (1024 * 1024))
    return redirect(`/upload?error=Storage+limit+reached+%28${limitMB}+MB%29`)
  }

  // Save to temp dir for page-count extraction
  const tmpPath = `/tmp/scroll-${crypto.randomUUID()}${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  await writeFile(tmpPath, buffer)

  const title = file.name.replace(/\.[^.]+$/, '')

  // Get page count and TOC before inserting — fast Rust extraction
  let totalPages = 1
  let toc: { title: string; page: number; level: number; fragment?: string }[] = []
  try {
    const [pageCount, tocEntries] = await Promise.all([
      getPageCount(tmpPath),
      extractToc(tmpPath),
    ])
    totalPages = pageCount
    toc = tocEntries
  } catch (err) {
    console.error('[upload] preview extraction failed:', err)
    await unlink(tmpPath).catch(() => {})
    return redirect('/upload?error=Could+not+read+document')
  }

  await unlink(tmpPath).catch(() => {})

  // Insert document to get an ID for the storage path
  const [doc] = await db
    .insert(documents)
    .values({
      userId,
      title,
      source: 'upload',
      filePath: '',
      fileSize: file.size,
      processingStatus: 'preview',
      totalPages,
      pageStart: 1,
      pageEnd: totalPages,
      toc: toc.length > 0 ? toc : null,
    })
    .returning()

  // Upload to Supabase Storage: {userId}/{docId}/original.epub
  try {
    const path = await uploadDocument(userId, doc.id, ext, buffer)
    await db.update(documents).set({ filePath: path }).where(eq(documents.id, doc.id))
  } catch (err) {
    console.error('[upload] storage upload failed:', err)
    await db.delete(documents).where(eq(documents.id, doc.id))
    return redirect('/upload?error=Could+not+store+document')
  }

  await db.insert(jobs).values({ userId, documentId: doc.id }).returning()

  return redirect(`/doc/${doc.id}`)
}
