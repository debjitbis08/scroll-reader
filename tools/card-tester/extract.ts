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
    out: { type: 'string', default: join(HERE, 'test-output') },
  },
})

if (!values.file) {
  console.error('Usage: pnpm --filter card-tester extract -- --file path/to/book.pdf [--pages 1-10] [--out dir]')
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
      if (code !== 0) {
        console.warn(`[figure-extract] exited ${code}: ${stderr.trim()}`)
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

// ── Types ──

interface DocElement {
  type: 'text' | 'image' | 'code'
  content?: string
  alt?: string
  file?: string
  mime?: string
  chapter?: string
  language?: string
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
  elements = elements.filter((el) => {
    if (el.type === 'text' || el.type === 'code') {
      const m = el.chapter?.match(/^Page\s+(\d+)$/i)
      const page = m ? parseInt(m[1], 10) : 1
      return page >= pageStart && page <= pageEnd
    }
    return true // keep images (they've been placed at correct positions)
  })
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
