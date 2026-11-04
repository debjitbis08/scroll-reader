// Helpers for turning raw Gutenberg catalog fields into display-friendly metadata.

export interface Contributor {
  /** Display name, e.g. "James Perry Johnston" */
  name: string
  /** Name as catalogued, e.g. "Johnston, J. P. (James Perry)" */
  sortName: string
  /** Life dates as catalogued, e.g. "1852–1915", "1852–", "384 BCE–322 BCE" */
  lifespan: string | null
  /** e.g. "Illustrator", "Translator"; null for the primary author */
  role: string | null
}

/**
 * Parse Gutenberg's author field, e.g.
 *   "Johnston, J. P. (James Perry), 1852-; Denslow, W. W. (William Wallace), 1856-1915 [Illustrator]"
 */
export function parseContributors(raw: string | null): Contributor[] {
  if (!raw) return []
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      let rest = entry
      let role: string | null = null
      const roleMatch = rest.match(/\s*\[([^\]]+)\]\s*$/)
      if (roleMatch) {
        role = roleMatch[1].trim()
        rest = rest.slice(0, roleMatch.index).trim()
      }

      let lifespan: string | null = null
      // Trailing life dates: ", 1852-1915", ", 1852-", ", -1915", ", 1743?-1826", ", 384 BCE-322 BCE"
      const datePart = String.raw`(?:\d{1,4}\??(?:\s*BCE)?)`
      const yearsMatch = rest.match(new RegExp(String.raw`,\s*(${datePart}?)\s*-\s*(${datePart}?)\s*$`))
      if (yearsMatch && (yearsMatch[1] || yearsMatch[2])) {
        lifespan = `${yearsMatch[1] || '?'}–${yearsMatch[2]}`
        rest = rest.slice(0, yearsMatch.index).trim()
      }

      return { name: displayName(rest), sortName: rest, lifespan, role }
    })
}

/** "Johnston, J. P. (James Perry)" → "James Perry Johnston"; "Jefferson, Thomas" → "Thomas Jefferson". */
function displayName(sortName: string): string {
  const comma = sortName.indexOf(',')
  if (comma === -1) return sortName
  const last = sortName.slice(0, comma).trim()
  const given = sortName.slice(comma + 1).trim()
  const full = given.match(/\(([^)]+)\)/)
  if (full) return `${full[1].trim()} ${last}`
  // Names like "Augustine, of Hippo, Saint" don't invert cleanly — keep as catalogued
  if (given.includes(',')) return sortName
  return `${given} ${last}`
}

/** Split a semicolon-separated CSV field. */
export function splitList(raw: string | null): string[] {
  return raw?.split(';').map((s) => s.trim()).filter(Boolean) ?? []
}

/** Bookshelves come as "Politics; Category: History - American" — strip the prefix and dedupe. */
export function cleanBookshelves(raw: string | null): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const shelf of splitList(raw)) {
    const name = shelf.replace(/^Category:\s*/i, '')
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

// ── Gutendex summary (cached in memory) ──────────────────────────────

export interface GutendexExtras {
  summary: string | null
  downloadCount: number | null
}

const CACHE_MAX = 500
const MISS_TTL_MS = 60 * 60 * 1000
const extrasCache = new Map<number, { value: GutendexExtras; expiresAt: number }>()

/**
 * Fetch the book summary and download count from Gutendex. Gutendex can be
 * slow or down, so this times out quickly and returns nulls on failure.
 * Successful results are cached for the process lifetime; failures for an hour.
 */
export async function fetchGutendexExtras(gutenbergId: number): Promise<GutendexExtras> {
  const cached = extrasCache.get(gutenbergId)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value: GutendexExtras = { summary: null, downloadCount: null }
  let ok = false
  try {
    const res = await fetch(`https://gutendex.com/books/${gutenbergId}/`, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = (await res.json()) as { summaries?: string[]; download_count?: number }
      value = {
        summary: cleanSummary(data.summaries?.[0] ?? null),
        downloadCount: typeof data.download_count === 'number' ? data.download_count : null,
      }
      ok = true
    }
  } catch (err) {
    console.warn(`[gutendex] summary fetch failed for ${gutenbergId}:`, err instanceof Error ? err.message : err)
  }

  if (extrasCache.size >= CACHE_MAX) {
    const oldest = extrasCache.keys().next().value
    if (oldest !== undefined) extrasCache.delete(oldest)
  }
  extrasCache.set(gutenbergId, { value, expiresAt: ok ? Infinity : Date.now() + MISS_TTL_MS })
  return value
}

function cleanSummary(summary: string | null): string | null {
  if (!summary) return null
  const text = summary.replace(/\s*\(This is an automatically generated summary\.\)\s*$/i, '').trim()
  return text || null
}
