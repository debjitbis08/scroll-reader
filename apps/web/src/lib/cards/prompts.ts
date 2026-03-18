import type { Document, Chunk } from '@scroll-reader/db'
import type { CardType } from '@scroll-reader/shared-types'

/**
 * Builds the AI prompt for a given card type.
 *
 * prevChunk is always chunk N-1 from the DB (may be null for the first chunk,
 * or may be an image chunk whose `content` is the alt text).
 * The AI uses it for context only — the main passage is what generates the card.
 */
export function buildPrompt(
  cardType: CardType,
  chunk: Chunk,
  prevChunk: Chunk | null,
  doc: Document,
): string {
  const docLabel = doc.title ?? 'Untitled'

  const contextBlock = prevChunk
    ? prevChunk.chunkType === 'image'
      ? `[Prior content was an image: ${prevChunk.content || 'no alt text'}]\n\n`
      : `[Prior passage — for context only]\n${prevChunk.content}\n\n`
    : ''

  const passageBlock = `[Passage from "${docLabel}"]\n${chunk.content}`

  switch (cardType) {
    case 'reflect':
      return `${contextBlock}${passageBlock}

Write a single reflective question that invites the reader to connect this idea to their own life, beliefs, or experience. The question should be open-ended, personally meaningful, and one to two sentences. Output only the question, no preamble or explanation.`

    case 'discover':
      return `${contextBlock}${passageBlock}

Surface one surprising or illuminating idea from this passage that a thoughtful reader would find unexpected or worth sitting with. Write it as a concise, self-contained insight in two to three sentences. Output only the insight, no preamble.`

    case 'raw_commentary':
      return `${contextBlock}${passageBlock}

Write a brief, direct marginal note on this passage — the kind a thoughtful reader would scribble in the margin. Be specific to the text. Two to three sentences. Output only the commentary, no preamble.`

    case 'connect':
    case 'sanskrit':
      throw new Error(`Card type "${cardType}" is not handled by buildPrompt in Phase 1`)
  }
}
