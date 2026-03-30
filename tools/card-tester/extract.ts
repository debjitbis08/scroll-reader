#!/usr/bin/env tsx
/**
 * Extract + chunk a document file → chunks.json
 *
 * Usage:
 *   pnpm --filter card-tester extract -- --file path/to/book.pdf [--pages 1-10] [--out ./test-output]
 */

import { writeFile, mkdir, copyFile } from 'node:fs/promises'
import { extname, dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  extractDocument, extractToc, filterByPageRange,
  callChunker, mergeConsecutiveCode, foldSmallCodeIntoText,
} from '@scroll-reader/pipeline'
import type { DocElement, TocEntry, PipelineChunk, ExtractConfig, ChunkerConfig } from '@scroll-reader/pipeline'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

// ── Config (uses release builds for card-tester) ──

const extractConfig: ExtractConfig = {
  extractorBin: process.env.EXTRACTOR_BIN || join(ROOT, 'packages/extractor/target/release/extractor'),
  figureExtractBin: process.env.FIGURE_EXTRACT_BIN || join(ROOT, 'packages/extractor/figure_extract.py'),
}
const chunkerConfig: ChunkerConfig = {
  chunkerBin: process.env.CHUNKER_BIN || join(ROOT, 'packages/chunker/target/release/chunker'),
}

// ── CLI args ──

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
const ext = extname(filePath).toLowerCase()

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

// ── TOC command ──

if (values.toc) {
  const toc = await extractToc(filePath, extractConfig)
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

// ── Resolve --chapters to page range ──

if (values.chapters) {
  const toc = await extractToc(filePath, extractConfig)
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
  }
  if (selectedPages.length > 0) {
    pageStart = Math.min(...selectedPages)
    pageEnd = Math.max(...selectedPages.filter((p) => p !== Infinity))
    if (pageEnd === -Infinity) pageEnd = Infinity
    console.log(`Chapters resolved to pages ${pageStart}-${pageEnd === Infinity ? 'end' : pageEnd}`)
  }
}

// ── Extract ──

console.log(`Extracting: ${filePath}`)

let elements = await extractDocument(filePath, extractConfig, imageDir)
console.log(`  Extracted: ${elements.length} elements`)

// Filter by page range
if (pageStart > 0) {
  elements = filterByPageRange(elements, ext, pageStart, pageEnd)
}

console.log(`  After filtering: ${elements.length} elements`)

// Merge consecutive code elements
elements = mergeConsecutiveCode(elements)
console.log(`  After merging code elements: ${elements.length} elements`)

// ── Chunk ──

console.log('Chunking...')

const chunks: PipelineChunk[] = []
let pendingImages: { file: string; alt: string; mime: string }[] = []

for (const el of elements) {
  if (el.type === 'image') {
    if (el.file && el.mime) {
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
      content: el.content,
      chapter: el.chapter ?? null,
      chunkType: 'code',
      wordCount: el.content.split(/\s+/).filter(Boolean).length,
      language: el.language ?? 'en',
      images: pendingImages,
    })
    pendingImages = []
    continue
  }

  // Text: use mechanical chunker
  const text = el.content
  if (text.trim().length < 20) continue

  try {
    const textChunks = await callChunker(text, chunkerConfig)

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

// Fold small code chunks into adjacent text
const folded = foldSmallCodeIntoText(chunks)

// Write output
const outPath = join(outDir, 'chunks.json')
await writeFile(outPath, JSON.stringify(folded, null, 2))

console.log(`\nDone! ${folded.length} chunks written to ${outPath}`)
console.log(`  Images: ${(await import('node:fs')).readdirSync(imageDir).length} files in ${imageDir}`)
