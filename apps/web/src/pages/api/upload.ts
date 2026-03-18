import type { APIRoute } from 'astro'
import { writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '../../lib/db.ts'
import { documents, jobs } from '@scroll-reader/db'
import { getPageCount } from '../../lib/extract.ts'

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

  // Save to temp dir
  const tmpPath = `/tmp/scroll-${crypto.randomUUID()}${ext}`
  const bytes = await file.arrayBuffer()
  await writeFile(tmpPath, Buffer.from(bytes))

  const title = file.name.replace(/\.[^.]+$/, '')
  const userId = locals.user.id

  // Insert document + job rows
  const [doc] = await db
    .insert(documents)
    .values({ userId, title, source: 'upload', filePath: tmpPath, processingStatus: 'pending' })
    .returning()

  await db.insert(jobs).values({ userId, documentId: doc.id }).returning()

  // Quick extraction to get page count, then show preview
  setImmediate(async () => {
    try {
      const totalPages = await getPageCount(tmpPath)
      await db
        .update(documents)
        .set({
          totalPages,
          pageStart: 1,
          pageEnd: totalPages,
          processingStatus: 'preview',
        })
        .where(eq(documents.id, doc.id))
    } catch (err) {
      console.error('[upload] preview extraction failed:', err)
      await db
        .update(documents)
        .set({ processingStatus: 'error' })
        .where(eq(documents.id, doc.id))
    }
  })

  return redirect(`/doc/${doc.id}`)
}
