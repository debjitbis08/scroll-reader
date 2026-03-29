#!/usr/bin/env tsx
/**
 * Extract + chunk a document file → chunks.json
 *
 * Usage:
 *   pnpm --filter card-tester extract -- --file path/to/book.pdf [--pages 1-10] [--out ./test-output]
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdir, copyFile } from 'node:fs/promises'
import { extname, dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

// ── CLI args ──

// Filter out bare "--" that pnpm injects
const args = process.argv.slice(2).filter(a => a !== '--')
const { values } = parseArgs({
  args,
  options: {
    file: { type: 'string' },
    pages: { type: 'string' },
    chapters: { type: 'string' },
    toc: { type: 'boolean', default: false },
    out: { type: 'string', default: join(HERE, 'test-output') },
  },
})

if (!values.file) {
  console.error('Usage: pnpm --filter card-tester extract -- --file path/to/book.pdf [--pages 1-10] [--chapters 1,3,5] [--toc] [--out dir]')
  process.exit(1)
}

const filePath = resolve(values.file)
const outDir = resolve(values.out!)
const imageDir = join(outDir, 'images')

await mkdir(imageDir, { recursive: true })

// ── Parse page range ──

let pageStart = 0
let pageEnd = Infinity
if (values.pages) {
  const m = values.pages.match(/^(\d+)(?:-(\d+))?$/)
  if (m) {
    pageStart = parseInt(m[1], 10)
    pageEnd = m[2] ? parseInt(m[2], 10) : pageStart
  }
}

// ── Binary helpers ──

function resolveBin(name: string, subdir: string): string {
  const envKey = `${name.toUpperCase()}_BIN`
  if (process.env[envKey]) return process.env[envKey]!
  return join(ROOT, subdir)
}

async function callBin(binPath: string, input: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`${binPath} exited ${code}: ${stderr.trim()}`))
      else resolve(stdout)
    })
    proc.on('error', (err) => reject(err))
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

async function callPython(scriptPath: string, input: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      // PyMuPDF may print warnings to stderr and exit with non-zero/null code
      // but still produce valid JSON on stdout — use stdout if it looks like JSON
      if (stdout.trim().startsWith('[')) {
        resolve(stdout)
      } else if (code !== 0) {
        console.warn(`[figure-extract] exited ${code}: ${stderr.trim().slice(0, 200)}`)
        resolve('[]')
      } else {
        resolve(stdout)
      }
    })
    proc.on('error', () => {
      console.warn('[figure-extract] python3 not available')
      resolve('[]')
    })
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

// ── TOC command ──

interface TocEntry { title: string; page: number; level: number; fragment?: string }

const extractorBinForToc = resolveBin('extractor', 'packages/extractor/target/release/extractor')

if (values.toc) {
  const tocOut = await callBin(extractorBinForToc, { file_path: filePath, command: 'toc' })
  const toc: TocEntry[] = JSON.parse(tocOut)
  if (toc.length === 0) {
    console.log('No table of contents found in this file.')
  } else {
    console.log(`Table of Contents (${toc.length} entries):\n`)
    for (let i = 0; i < toc.length; i++) {
      const e = toc[i]
      const indent = '  '.repeat(e.level)
      console.log(`  ${String(i + 1).padStart(3)}. ${indent}${e.title}`)
    }
  }
  process.exit(0)
}

// ── Resolve --chapters to page/fragment range ──

// For EPUB fragment-level filtering: list of { startFragment, endFragment, spinePage } ranges
let fragmentRanges: { startFragment: string; endFragment: string | null; spinePage: number }[] = []

if (values.chapters) {
  const tocOut = await callBin(extractorBinForToc, { file_path: filePath, command: 'toc' })
  const toc: TocEntry[] = JSON.parse(tocOut)
  if (toc.length === 0) {
    console.error('No TOC found — cannot use --chapters. Use --pages instead.')
    process.exit(1)
  }
  const selected = values.chapters.split(',').map((s) => parseInt(s.trim(), 10))
  const selectedPages: number[] = []
  for (const idx of selected) {
    const entry = toc[idx - 1] // 1-based index from user
    if (!entry) {
      console.error(`Chapter index ${idx} is out of range (1-${toc.length}). Run --toc to see the list.`)
      process.exit(1)
    }
    const nextEntry = toc.find((e, i) => i > idx - 1 && e.level <= entry.level)
    const endPage = nextEntry ? Math.max(nextEntry.page - 1, entry.page) : Infinity
    for (let p = entry.page; p <= endPage; p++) selectedPages.push(p)

    // Collect fragment range for EPUB sub-spine filtering
    if (entry.fragment) {
      fragmentRanges.push({
        startFragment: entry.fragment,
        endFragment: nextEntry?.fragment ?? null,
        spinePage: entry.page,
      })
    }
  }
  if (selectedPages.length > 0) {
    pageStart = Math.min(...selectedPages)
    pageEnd = Math.max(...selectedPages.filter((p) => p !== Infinity))
    if (pageEnd === -Infinity) pageEnd = Infinity
    console.log(`Chapters resolved to pages ${pageStart}-${pageEnd === Infinity ? 'end' : pageEnd}`)
  }
}

// ── Types ──

interface DocElement {
  type: 'text' | 'image' | 'code'
  content?: string
  alt?: string
  file?: string
  mime?: string
  chapter?: string
  language?: string
  spine_index?: number
  anchor_id?: string
}

interface TestChunk {
  content: string
  chapter: string | null
  chunkType: 'text' | 'code'
  wordCount: number
  language: string
  images: { file: string; alt: string; mime: string }[]
}

// ── Extract ──

console.log(`Extracting: ${filePath}`)
const ext = extname(filePath).toLowerCase()

const extractorBin = resolveBin('extractor', 'packages/extractor/target/release/extractor')
const figureScript = join(ROOT, 'packages/extractor/figure_extract.py')

// Run Rust extractor + Python figure extractor in parallel
const [rustOut, figOut] = await Promise.all([
  callBin(extractorBin, { file_path: filePath, output_dir: imageDir }),
  ext === '.pdf'
    ? callPython(figureScript, { file_path: filePath, output_dir: imageDir })
    : Promise.resolve('[]'),
])

let elements: DocElement[] = JSON.parse(rustOut)
const figures: (DocElement & { page?: number })[] = JSON.parse(figOut)

console.log(`  Rust elements: ${elements.length}, PyMuPDF figures: ${figures.length}`)

// Merge figures into elements (same logic as extract.ts mergeFigures)
if (figures.length > 0) {
  const figuresByPage = new Map<number, typeof figures>()
  for (const fig of figures) {
    const page = fig.page ?? 0
    const list = figuresByPage.get(page) || []
    list.push(fig)
    figuresByPage.set(page, list)
  }

  const usedPages = new Set<number>()
  const merged: DocElement[] = []

  for (const el of elements) {
    if (el.type === 'image' && !el.file) {
      const pageMatch = el.alt?.match(/page\s+(\d+)/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0
      const pageFigures = figuresByPage.get(page)
      if (pageFigures && !usedPages.has(page)) {
        for (const fig of pageFigures) {
          merged.push({ type: 'image', alt: fig.alt ?? '', file: fig.file, mime: fig.mime })
        }
        usedPages.add(page)
      }
      continue
    }
    // Insert figures at correct page position
    if (el.type === 'text' || el.type === 'code') {
      const pageMatch = el.chapter?.match(/^Page\s+(\d+)$/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0
      if (page > 0) {
        for (const [figPage, figs] of figuresByPage) {
          if (figPage <= page && !usedPages.has(figPage)) {
            for (const fig of figs) {
              merged.push({ type: 'image', alt: fig.alt ?? '', file: fig.file, mime: fig.mime })
            }
            usedPages.add(figPage)
          }
        }
      }
    }
    merged.push(el)
  }

  // Append remaining
  for (const [page, figs] of figuresByPage) {
    if (!usedPages.has(page)) {
      for (const fig of figs) {
        merged.push({ type: 'image', alt: fig.alt ?? '', file: fig.file, mime: fig.mime })
      }
    }
  }

  elements = merged
}

// Filter by page range
if (pageStart > 0 && ext === '.pdf') {
  // PDF: track current page from chapter field ("Page N")
  let currentPage = 1
  elements = elements.filter((el) => {
    if (el.type === 'text' || el.type === 'code') {
      const m = el.chapter?.match(/^Page\s+(\d+)$/i)
      if (m) currentPage = parseInt(m[1], 10)
      return currentPage >= pageStart && currentPage <= pageEnd
    }
    return currentPage >= pageStart && currentPage <= pageEnd
  })
} else if (pageStart > 0 && (ext === '.epub' || ext === '.kepub')) {
  if (fragmentRanges.length > 0) {
    // EPUB with fragments: filter by anchor_id ranges within spine pages
    // Build a set of "end" fragments so we know when to stop
    const endFragments = new Set(fragmentRanges.map((r) => r.endFragment).filter(Boolean) as string[])
    const startFragments = new Set(fragmentRanges.map((r) => r.startFragment))
    const spinePages = new Set(fragmentRanges.map((r) => r.spinePage))

    let inside = false
    elements = elements.filter((el) => {
      const si = el.spine_index ?? 0
      const anchor = el.anchor_id

      // Outside the relevant spine pages entirely — exclude
      if (!spinePages.has(si)) return false

      // Check if this element starts a selected range
      if (anchor && startFragments.has(anchor)) {
        inside = true
      }

      // Check if this element starts the next (unselected) section
      if (anchor && endFragments.has(anchor) && !startFragments.has(anchor)) {
        inside = false
        return false
      }

      return inside
    })
  } else {
    // No fragments — fall back to spine_index filtering
    elements = elements.filter((el) => {
      const si = el.spine_index ?? 0
      return si >= pageStart && si <= pageEnd
    })
  }
}

console.log(`  After filtering: ${elements.length} elements`)

// ── Chunk ──

console.log('Chunking...')

const chunkerBin = resolveBin('chunker', 'packages/chunker/target/release/chunker')
const chunks: TestChunk[] = []
let pendingImages: { file: string; alt: string; mime: string }[] = []

for (const el of elements) {
  if (el.type === 'image') {
    if (el.file && el.mime) {
      // Copy image to output dir if it's not already there
      const imgName = basename(el.file)
      const dest = join(imageDir, imgName)
      try {
        await copyFile(el.file, dest)
      } catch { /* already there */ }
      pendingImages.push({ file: `images/${imgName}`, alt: el.alt ?? '', mime: el.mime })
    }
    continue
  }

  if (el.type === 'code') {
    chunks.push({
      content: el.content ?? '',
      chapter: el.chapter ?? null,
      chunkType: 'code',
      wordCount: (el.content ?? '').split(/\s+/).filter(Boolean).length,
      language: el.language ?? 'en',
      images: pendingImages,
    })
    pendingImages = []
    continue
  }

  // Text: use mechanical chunker (no AI provider needed for testing)
  const text = el.content ?? ''
  if (text.trim().length < 20) continue

  try {
    const result = await callBin(chunkerBin, { text })
    const textChunks: { content: string; word_count: number; chapter: string | null; language: string }[] = JSON.parse(result)

    for (let i = 0; i < textChunks.length; i++) {
      const c = textChunks[i]
      chunks.push({
        content: c.content,
        chapter: c.chapter ?? el.chapter ?? null,
        chunkType: 'text',
        wordCount: c.word_count,
        language: c.language,
        images: i === 0 ? pendingImages : [],
      })
    }
    pendingImages = []
  } catch (err) {
    console.warn(`  Chunker failed, using raw text:`, (err as Error).message)
    chunks.push({
      content: text,
      chapter: el.chapter ?? null,
      chunkType: 'text',
      wordCount: text.split(/\s+/).filter(Boolean).length,
      language: 'en',
      images: pendingImages,
    })
    pendingImages = []
  }
}

// Attach trailing images to last chunk
if (pendingImages.length > 0 && chunks.length > 0) {
  chunks[chunks.length - 1].images.push(...pendingImages)
}

// Write output
const outPath = join(outDir, 'chunks.json')
await writeFile(outPath, JSON.stringify(chunks, null, 2))

console.log(`\nDone! ${chunks.length} chunks written to ${outPath}`)
console.log(`  Images: ${(await import('node:fs')).readdirSync(imageDir).length} files in ${imageDir}`)
