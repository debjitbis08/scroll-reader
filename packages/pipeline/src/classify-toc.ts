import type { TocEntry, AIProvider, AIUsage } from './types.ts'

export type TocSection = 'front' | 'main' | 'back'

const FRONT_RE = /copyright|dedication|foreword|preface|acknowledg|title\s*page|table\s*of\s*contents|front\s*matter|also\s*by|epigraph|half[\s-]?title|series\s*page/i
const BACK_RE = /appendix|bibliograph|index(?:es)?|glossary|about\s*the\s*author|colophon|back\s*matter|endnotes?|references|further\s*reading|permissions|credits/i

/**
 * Heuristic fallback: classify TOC entries by title pattern matching.
 */
export function classifyTocHeuristic(toc: TocEntry[]): TocSection[] {
  let seenMain = false
  return toc.map((entry) => {
    if (!seenMain && FRONT_RE.test(entry.title)) return 'front'
    if (BACK_RE.test(entry.title)) return 'back'
    seenMain = true
    return 'main'
  })
}

/**
 * Classify each TOC entry as frontmatter, mainmatter, or backmatter.
 *
 * Uses the AI provider for nuanced classification (e.g. distinguishing
 * an "Introduction" that is substantive mainmatter from a brief preface).
 * Falls back to heuristic regex if the AI call fails or returns bad data.
 */
export async function classifyToc(
  toc: TocEntry[],
  provider: AIProvider,
): Promise<{ classification: TocSection[]; usage: AIUsage | null }> {
  if (toc.length === 0) return { classification: [], usage: null }

  const tocList = toc
    .map((entry, i) => `${i}. ${'  '.repeat(entry.level)}${entry.title}`)
    .join('\n')

  const prompt = `Classify each table-of-contents entry as "front", "main", or "back".

- "front" = frontmatter: title page, copyright, dedication, foreword, preface, acknowledgments, table of contents, epigraph, "also by", series page, half-title — material before the main body.
- "main" = main body content: chapters, parts, sections with substantive content. An introduction or prologue that contains actual content (not just a brief note) is "main".
- "back" = backmatter: appendix, bibliography, index, glossary, about the author, colophon, endnotes, references, further reading, permissions.

Entries are ordered as they appear in the document. Frontmatter entries always come before mainmatter. Backmatter entries always come after mainmatter.

Table of Contents:
${tocList}

Respond with ONLY a JSON array of ${toc.length} strings, one per entry in the same order. Example: ["front","front","main","main","back"]`

  try {
    const response = await provider.generate(prompt)
    // Strip markdown code fences if the model wraps the JSON in ```json ... ```
    const raw = response.text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    const parsed = JSON.parse(raw) as unknown

    if (
      Array.isArray(parsed) &&
      parsed.length === toc.length &&
      parsed.every((v) => v === 'front' || v === 'main' || v === 'back')
    ) {
      return { classification: parsed as TocSection[], usage: response.usage }
    }

    console.warn('[classify-toc] AI returned invalid structure, falling back to heuristic')
    return { classification: classifyTocHeuristic(toc), usage: response.usage }
  } catch (err) {
    console.warn('[classify-toc] AI call failed, falling back to heuristic:', err)
    return { classification: classifyTocHeuristic(toc), usage: null }
  }
}
