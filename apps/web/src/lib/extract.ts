import { readFile } from 'node:fs/promises'
import { extname, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { EXTRACTOR_BIN } from 'astro:env/server'

export interface TextElement { type: 'text'; content: string; chapter?: string }
export interface ImageElement {
  type: 'image'
  alt: string
  file?: string  // path to extracted image on disk (temp dir)
  mime?: string  // e.g. "image/png", "image/jpeg"
}
export interface CodeElement { type: 'code'; content: string; language?: string; chapter?: string }
export type DocElement = TextElement | ImageElement | CodeElement

function resolveExtractorBin(): string {
  if (EXTRACTOR_BIN) return EXTRACTOR_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../../packages/extractor/target/debug/extractor')
}

export async function extractDocument(filePath: string, outputDir?: string): Promise<DocElement[]> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt') {
    const content = await readFile(filePath, 'utf-8')
    return [{ type: 'text', content }]
  }
  if (ext === '.epub' || ext === '.pdf') return callExtractor(filePath, outputDir)
  throw new Error(`Unsupported file type: ${ext}`)
}

/**
 * Quick extraction to count pages/sections for the preview step.
 * PDF: counts unique "Page N" labels. EPUB: counts unique chapters.
 * TXT: returns 1.
 */
export async function getPageCount(filePath: string): Promise<number> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt') return 1

  const elements = await callExtractor(filePath)
  return countPages(elements, ext)
}

/**
 * Filters extracted elements to only include those within the given page range.
 * For PDFs, pages are derived from "Page N" chapter labels.
 * For EPUBs, pages are sequential section numbers.
 * TXT always returns all content.
 */
export function filterByPageRange(
  elements: DocElement[],
  ext: string,
  pageStart: number,
  pageEnd: number,
): DocElement[] {
  if (ext === '.txt') return elements
  const tagged = tagWithPages(elements, ext)
  return tagged
    .filter(({ page }) => page >= pageStart && page <= pageEnd)
    .map(({ element }) => element)
}

function countPages(elements: DocElement[], ext: string): number {
  const tagged = tagWithPages(elements, ext)
  const pages = new Set(tagged.map(({ page }) => page))
  return pages.size || 1
}

function tagWithPages(
  elements: DocElement[],
  ext: string,
): { element: DocElement; page: number }[] {
  if (ext === '.pdf') {
    // PDF elements have chapter: "Page N"
    return elements.map((el) => {
      const chapter = el.type === 'text' || el.type === 'code' ? el.chapter : undefined
      const match = chapter?.match(/^Page\s+(\d+)$/i)
      const page = match ? parseInt(match[1], 10) : 1
      return { element: el, page }
    })
  }

  // EPUB: assign sequential section numbers based on chapter changes
  let currentPage = 1
  let lastChapter: string | undefined
  return elements.map((el) => {
    const chapter = el.type === 'text' || el.type === 'code' ? el.chapter : undefined
    if (chapter && chapter !== lastChapter) {
      if (lastChapter !== undefined) currentPage++
      lastChapter = chapter
    }
    return { element: el, page: currentPage }
  })
}

async function callExtractor(filePath: string, outputDir?: string): Promise<DocElement[]> {
  const binPath = resolveExtractorBin()

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`extractor exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as DocElement[])
      } catch {
        reject(new Error(`extractor output is not valid JSON: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn extractor at "${binPath}": ${err.message}`))
    })

    const input: Record<string, string> = { file_path: filePath }
    if (outputDir) input.output_dir = outputDir
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}
