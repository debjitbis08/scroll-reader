import { readFile } from 'node:fs/promises'
import { extname, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { EXTRACTOR_BIN, FIGURE_EXTRACT_BIN } from 'astro:env/server'

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
  if (ext === '.epub') return callExtractor(filePath, outputDir)
  if (ext === '.pdf') {
    const [rustElements, figures] = await Promise.all([
      callExtractor(filePath, outputDir),
      outputDir ? callFigureExtractor(filePath, outputDir) : Promise.resolve([]),
    ])
    return mergeFigures(rustElements, figures)
  }
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

interface FigureElement extends ImageElement {
  page: number
}

function resolveFigureExtractBin(): string {
  if (FIGURE_EXTRACT_BIN) return FIGURE_EXTRACT_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../../packages/extractor/figure_extract.py')
}

async function callFigureExtractor(filePath: string, outputDir: string): Promise<FigureElement[]> {
  const scriptPath = resolveFigureExtractBin()

  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        // Non-fatal: if figure extraction fails, we still have the Rust output
        console.warn(`[figure-extract] exited ${code}: ${stderr.trim()}`)
        resolve([])
        return
      }
      try {
        resolve(JSON.parse(stdout) as FigureElement[])
      } catch {
        console.warn(`[figure-extract] invalid JSON output`)
        resolve([])
      }
    })

    proc.on('error', () => {
      // python3 not available or script missing — non-fatal
      console.warn(`[figure-extract] failed to spawn python3`)
      resolve([])
    })

    proc.stdin.write(JSON.stringify({ file_path: filePath, output_dir: outputDir }))
    proc.stdin.end()
  })
}

/**
 * Merge PyMuPDF-extracted vector figures into the Rust extractor output.
 *
 * Strategy:
 * 1. Replace placeholder image elements (no file) with rendered figures
 *    from the same page.
 * 2. Insert remaining figures (from pages that had no placeholder) at
 *    the correct position based on page number.
 */
function mergeFigures(rustElements: DocElement[], figures: FigureElement[]): DocElement[] {
  if (figures.length === 0) return rustElements

  // Group figures by page
  const figuresByPage = new Map<number, FigureElement[]>()
  for (const fig of figures) {
    const list = figuresByPage.get(fig.page) || []
    list.push(fig)
    figuresByPage.set(fig.page, list)
  }

  const usedPages = new Set<number>()
  const result: DocElement[] = []

  for (const el of rustElements) {
    if (el.type === 'image' && !el.file) {
      // Placeholder image from Rust — try to replace with rendered figure
      const pageMatch = el.alt.match(/page\s+(\d+)/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0
      const pageFigures = figuresByPage.get(page)

      if (pageFigures && pageFigures.length > 0) {
        // Replace placeholder with all figures from this page
        if (!usedPages.has(page)) {
          for (const fig of pageFigures) {
            result.push({ type: 'image', alt: fig.alt, file: fig.file, mime: fig.mime })
          }
          usedPages.add(page)
        }
        // Skip the placeholder either way
        continue
      }
    }

    // Check if we need to insert figures before this element (by page)
    if (el.type === 'text' || el.type === 'code') {
      const chapter = el.chapter
      const pageMatch = chapter?.match(/^Page\s+(\d+)$/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0

      if (page > 0) {
        // Insert any figures from earlier pages that haven't been used yet
        for (const [figPage, figs] of figuresByPage) {
          if (figPage <= page && !usedPages.has(figPage)) {
            for (const fig of figs) {
              result.push({ type: 'image', alt: fig.alt, file: fig.file, mime: fig.mime })
            }
            usedPages.add(figPage)
          }
        }
      }
    }

    result.push(el)
  }

  // Append any remaining figures that weren't placed
  for (const [page, figs] of figuresByPage) {
    if (!usedPages.has(page)) {
      for (const fig of figs) {
        result.push({ type: 'image', alt: fig.alt, file: fig.file, mime: fig.mime })
      }
    }
  }

  return result
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
