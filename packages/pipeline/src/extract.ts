import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { callBin, callPython } from './bin-caller.ts'
import type { DocElement, ImageElement, TocEntry, ExtractConfig } from './types.ts'

interface FigureElement extends ImageElement {
  page: number
}

export async function extractDocument(
  filePath: string,
  config: ExtractConfig,
  outputDir?: string,
): Promise<DocElement[]> {
  const ext = extname(filePath).toLowerCase()

  if (ext === '.txt') {
    const content = await readFile(filePath, 'utf-8')
    return [{ type: 'text', content }]
  }

  if (ext === '.epub' || ext === '.kepub') {
    return callExtractor(filePath, config, outputDir)
  }

  if (ext === '.pdf') {
    const [rustElements, figures] = await Promise.all([
      callExtractor(filePath, config, outputDir),
      config.figureExtractBin && outputDir
        ? callFigureExtractor(filePath, outputDir, config.figureExtractBin)
        : Promise.resolve([]),
    ])
    return mergeFigures(rustElements, figures)
  }

  throw new Error(`Unsupported file type: ${ext}`)
}

export async function extractToc(
  filePath: string,
  config: ExtractConfig,
): Promise<TocEntry[]> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt') return []

  try {
    const out = await callBin(
      config.extractorBin,
      { file_path: filePath, command: 'toc' },
      'extractor',
    )
    return JSON.parse(out) as TocEntry[]
  } catch {
    return []
  }
}

/**
 * Quick extraction to count pages/sections for the preview step.
 */
export async function getPageCount(filePath: string, config: ExtractConfig): Promise<number> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.txt') return 1

  const elements = await callExtractor(filePath, config)
  return countPages(elements, ext)
}

// ── Internal helpers ──

async function callExtractor(
  filePath: string,
  config: ExtractConfig,
  outputDir?: string,
): Promise<DocElement[]> {
  const input: Record<string, string> = { file_path: filePath }
  if (outputDir) input.output_dir = outputDir
  const out = await callBin(config.extractorBin, input, 'extractor')
  return JSON.parse(out) as DocElement[]
}

async function callFigureExtractor(
  filePath: string,
  outputDir: string,
  scriptPath: string,
): Promise<FigureElement[]> {
  const out = await callPython(
    scriptPath,
    { file_path: filePath, output_dir: outputDir },
    'figure-extract',
  )
  try {
    return JSON.parse(out) as FigureElement[]
  } catch {
    return []
  }
}

/**
 * Merge PyMuPDF-extracted vector figures into the Rust extractor output.
 */
function mergeFigures(rustElements: DocElement[], figures: FigureElement[]): DocElement[] {
  if (figures.length === 0) return rustElements

  const figuresByPage = new Map<number, FigureElement[]>()
  for (const fig of figures) {
    const page = fig.page ?? 0
    const list = figuresByPage.get(page) || []
    list.push(fig)
    figuresByPage.set(page, list)
  }

  const usedPages = new Set<number>()
  const result: DocElement[] = []

  for (const el of rustElements) {
    if (el.type === 'image' && !el.file) {
      const pageMatch = el.alt.match(/page\s+(\d+)/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0
      const pageFigures = figuresByPage.get(page)

      if (pageFigures && pageFigures.length > 0) {
        if (!usedPages.has(page)) {
          for (const fig of pageFigures) {
            result.push({ type: 'image', alt: fig.alt, file: fig.file, mime: fig.mime })
          }
          usedPages.add(page)
        }
        continue
      }
    }

    if (el.type === 'text' || el.type === 'code') {
      const chapter = el.chapter
      const pageMatch = chapter?.match(/^Page\s+(\d+)$/i)
      const page = pageMatch ? parseInt(pageMatch[1], 10) : 0

      if (page > 0) {
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

  // Append remaining figures
  for (const [page, figs] of figuresByPage) {
    if (!usedPages.has(page)) {
      for (const fig of figs) {
        result.push({ type: 'image', alt: fig.alt, file: fig.file, mime: fig.mime })
      }
    }
  }

  return result
}

// ── Page counting (for getPageCount) ──

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
    return elements.map((el) => {
      const chapter = el.type === 'text' || el.type === 'code' ? el.chapter : undefined
      const match = chapter?.match(/^Page\s+(\d+)$/i)
      const page = match ? parseInt(match[1], 10) : 1
      return { element: el, page }
    })
  }

  // EPUB: sequential section numbers based on chapter changes
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
