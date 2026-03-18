import type { APIRoute } from 'astro'
import { writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { db } from '../../lib/db.ts'
import { documents, jobs } from '@scroll-reader/db'
import { runPipeline } from '../../lib/pipeline.ts'

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

  const [job] = await db.insert(jobs).values({ userId, documentId: doc.id }).returning()

  // Fire-and-forget: respond immediately, process in background
  setImmediate(() => {
    runPipeline(job.id, tmpPath, userId, doc.id).catch((err) => {
      console.error('[upload] unhandled pipeline error:', err)
    })
  })

  return redirect(`/doc/${doc.id}`)
}
