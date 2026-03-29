import type { AIProvider, AIUsage } from './index.ts'
import type { ChunkerSegment } from '../chunker.ts'
import type { ChunkerChunk } from '../types.ts'

export interface AIChunkResult {
  chunks: ChunkerChunk[]
  usages: AIUsage[]
}

/** How many segments to send in one AI call. */
const WINDOW_SIZE = 15
/** Overlap between windows so the AI has boundary context. */
const OVERLAP = 3

/**
 * AI-assisted chunking (Pass 2).
 *
 * Takes raw segments from the Rust chunker and asks the AI to decide
 * which segments should be grouped together into semantically coherent
 * chunks. Falls back to returning each segment as its own chunk if the
 * AI response can't be parsed.
 */
export async function aiChunk(
  segments: ChunkerSegment[],
  provider: AIProvider,
): Promise<AIChunkResult> {
  if (segments.length === 0) return { chunks: [], usages: [] }

  const usages: AIUsage[] = []

  // For small documents, process in a single call
  if (segments.length <= WINDOW_SIZE) {
    const { groups, usage } = await callAIForGroups(segments, 0, provider)
    if (usage) usages.push(usage)
    return { chunks: groupsToChunks(segments, groups), usages }
  }

  // Sliding window for larger documents
  const allGroups: number[][] = []
  let cursor = 0

  while (cursor < segments.length) {
    const windowEnd = Math.min(cursor + WINDOW_SIZE, segments.length)
    const window = segments.slice(cursor, windowEnd)
    const { groups, usage } = await callAIForGroups(window, cursor, provider)
    if (usage) usages.push(usage)

    if (cursor === 0) {
      // First window: take all groups
      allGroups.push(...groups)
    } else {
      // Subsequent windows: skip groups that overlap with previous window
      // (they were already decided by the prior call)
      const firstNewIndex = cursor + OVERLAP
      for (const group of groups) {
        if (group[group.length - 1] >= firstNewIndex) {
          // Filter out any indices that belong to the overlap zone
          const filtered = group.filter((i) => i >= firstNewIndex)
          if (filtered.length > 0) allGroups.push(filtered)
        }
      }
    }

    cursor += WINDOW_SIZE - OVERLAP
  }

  return { chunks: groupsToChunks(segments, allGroups), usages }
}

async function callAIForGroups(
  window: ChunkerSegment[],
  offset: number,
  provider: AIProvider,
): Promise<{ groups: number[][]; usage: AIUsage | null }> {
  const prompt = buildChunkingPrompt(window, offset)

  try {
    const response = await provider.generate(prompt)
    return {
      groups: parseGroupingResponse(response.text, offset, offset + window.length - 1),
      usage: response.usage,
    }
  } catch (err) {
    console.warn(`[ai-chunk] AI call failed, falling back to one-segment-per-chunk:`, err)
    return { groups: window.map((_, i) => [offset + i]), usage: null }
  }
}

function buildChunkingPrompt(window: ChunkerSegment[], offset: number): string {
  const segmentList = window
    .map((seg, i) => {
      const idx = offset + i
      const meta = [
        `[${idx}]`,
        seg.chapter ? `chapter: "${seg.chapter}"` : null,
        `${seg.word_count} words`,
        seg.is_chapter_start ? 'CHAPTER START' : null,
      ]
        .filter(Boolean)
        .join(' | ')

      return `--- ${meta} ---\n${seg.content}`
    })
    .join('\n\n')

  return `You are a text chunking assistant. Your job is to group the numbered text segments below into semantically coherent chunks — passages that form a complete thought, argument, or idea.

RULES:
- Each chunk should be self-contained: a reader should be able to understand it without needing the surrounding text.
- Prefer chunks of 150–500 words, but prioritise semantic coherence over word count. A 80-word paragraph that is a complete thought should stay alone. A 600-word argument that can't be split should stay together.
- NEVER merge segments across chapter boundaries (segments marked CHAPTER START begin a new chapter).
- Keep the original segment order. Every segment index must appear exactly once.

SEGMENTS:
${segmentList}

Respond with ONLY a JSON array of arrays, where each inner array contains the segment indices that should be grouped into one chunk. Example: [[0,1,2],[3],[4,5]]

JSON:`
}

function parseGroupingResponse(
  response: string,
  minIndex: number,
  maxIndex: number,
): number[][] {
  // Extract JSON array from the response — handle markdown code fences
  const cleaned = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  let groups: number[][]

  try {
    groups = JSON.parse(cleaned)
  } catch {
    console.warn(`[ai-chunk] Could not parse AI response as JSON, falling back`)
    const fallback: number[][] = []
    for (let i = minIndex; i <= maxIndex; i++) {
      fallback.push([i])
    }
    return fallback
  }

  // Validate: must be array of arrays of numbers
  if (!Array.isArray(groups) || !groups.every((g) => Array.isArray(g) && g.every((n) => typeof n === 'number'))) {
    console.warn(`[ai-chunk] AI response is not array of arrays, falling back`)
    const fallback: number[][] = []
    for (let i = minIndex; i <= maxIndex; i++) {
      fallback.push([i])
    }
    return fallback
  }

  // Validate: all indices in range and each appears exactly once
  const seen = new Set<number>()
  for (const group of groups) {
    for (const idx of group) {
      if (idx < minIndex || idx > maxIndex) {
        console.warn(`[ai-chunk] Index ${idx} out of range [${minIndex}, ${maxIndex}], falling back`)
        const fallback: number[][] = []
        for (let i = minIndex; i <= maxIndex; i++) {
          fallback.push([i])
        }
        return fallback
      }
      seen.add(idx)
    }
  }

  // Fill in any missing indices as solo chunks
  for (let i = minIndex; i <= maxIndex; i++) {
    if (!seen.has(i)) {
      groups.push([i])
    }
  }

  // Sort groups by their first index
  groups.sort((a, b) => a[0] - b[0])

  return groups
}

function groupsToChunks(
  segments: ChunkerSegment[],
  groups: number[][],
): ChunkerChunk[] {
  return groups.map((group, chunkIndex) => {
    const segs = group.map((i) => segments[i])
    const content = segs.map((s) => s.content).join('\n\n')
    const wordCount = segs.reduce((sum, s) => sum + s.word_count, 0)
    const chapter = segs[0].chapter
    const lang = segs[0].language

    return {
      content,
      word_count: wordCount,
      chunk_index: chunkIndex,
      chapter,
      language: lang,
    }
  })
}
