import type { DocElement, TocEntry } from './types.ts'

/**
 * Filter elements to only include those within the given page range.
 * PDF: pages from "Page N" chapter labels. EPUB: sequential section numbers.
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

/**
 * Filter elements using TOC entries and selected indices.
 * EPUB: spine_index + anchor_id for fragment-level precision.
 * PDF: page number ranges from TOC entries.
 */
export function filterByToc(
  elements: DocElement[],
  ext: string,
  toc: TocEntry[],
  selectedIndices: number[],
  totalPages: number,
): DocElement[] {
  if (selectedIndices.length === 0) return []

  type FragmentRange = { startFragment: string; endFragment: string | null; spinePage: number }
  const fragmentRanges: FragmentRange[] = []
  const selectedPageSet = new Set<number>()

  for (const idx of selectedIndices) {
    const entry = toc[idx]
    if (!entry) continue
    const nextEntry = toc.find((e, i) => i > idx && e.level <= entry.level)
    const endPage = nextEntry ? Math.max(nextEntry.page - 1, entry.page) : totalPages

    for (let p = entry.page; p <= endPage; p++) selectedPageSet.add(p)

    if (entry.fragment) {
      fragmentRanges.push({
        startFragment: entry.fragment,
        endFragment: nextEntry?.fragment ?? null,
        spinePage: entry.page,
      })
    }
  }

  const isEpub = ext === '.epub' || ext === '.kepub'

  if (isEpub && fragmentRanges.length > 0) {
    const endFragments = new Set(
      fragmentRanges.map((r) => r.endFragment).filter(Boolean) as string[],
    )
    const startFragments = new Set(fragmentRanges.map((r) => r.startFragment))
    const spinePages = new Set(fragmentRanges.map((r) => r.spinePage))

    // If no elements on target spine pages have anchor_ids, the extractor
    // doesn't support fragments for this EPUB — fall through to spine_index filtering.
    const hasAnchors = elements.some(
      (el) => spinePages.has(el.spine_index ?? 0) && el.anchor_id,
    )

    if (hasAnchors) {
      let inside = false
      const filtered = elements.filter((el) => {
        const si = el.spine_index ?? 0
        const anchor = el.anchor_id

        if (!spinePages.has(si)) return false

        if (anchor && startFragments.has(anchor)) {
          inside = true
        }
        if (anchor && endFragments.has(anchor) && !startFragments.has(anchor)) {
          inside = false
          return false
        }

        return inside
      })
      // If fragment matching found nothing (e.g. extractor doesn't split by
      // these specific anchors), fall through to spine_index filtering.
      if (filtered.length > 0) return filtered
    }
  }

  if (isEpub) {
    return elements.filter((el) => {
      const si = el.spine_index ?? 0
      return selectedPageSet.has(si)
    })
  }

  // PDF: filter by page number from "Page N" chapter labels
  let currentPage = 1
  return elements.filter((el) => {
    if (el.type === 'text' || el.type === 'code') {
      const m = el.chapter?.match(/^Page\s+(\d+)$/i)
      if (m) currentPage = parseInt(m[1], 10)
    }
    return selectedPageSet.has(currentPage)
  })
}

// ── Internal ──

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

  // EPUB: use spine_index directly (consistent with TOC page references)
  return elements.map((el) => ({
    element: el,
    page: el.spine_index ?? 1,
  }))
}
