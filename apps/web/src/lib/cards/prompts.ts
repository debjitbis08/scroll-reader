import type { Document, Chunk } from '@scroll-reader/db'
import type { CardType, CardStrategy } from '@scroll-reader/shared-types'

const CARD_TYPE_DESCRIPTIONS: Record<CardType, string> = {
  reflect: 'Reflect — an open-ended question connecting the idea to the reader\'s life, beliefs, or experience. 1-2 sentences.',
  discover: 'Discover — one surprising or illuminating insight from the passage that a reader would find worth sitting with. 2-3 sentences.',
  raw_commentary: 'Notes — a brief, direct marginal note, the kind a thoughtful reader scribbles in the margin. Specific to the text. 2-3 sentences.',
  connect: 'Connect — links this passage to ideas from elsewhere in the book or other works.',
  sanskrit: 'Sanskrit — commentary on Sanskrit/Devanagari source text.',
}

/**
 * Builds a single intelligent prompt that asks the AI to analyze the passage
 * and produce appropriate cards. The strategy is a suggestion, not a mandate —
 * the AI decides what actually makes sense for the content.
 */
export function buildSmartPrompt(
  chunk: Chunk,
  prevChunk: Chunk | null,
  doc: Document,
  strategy?: CardStrategy | null,
): string {
  const docLabel = doc.title ?? 'Untitled'

  const contextBlock = prevChunk
    ? prevChunk.chunkType === 'image'
      ? `[Prior content was an image: ${prevChunk.content || 'no alt text'}]\n\n`
      : prevChunk.chunkType === 'code'
        ? `[Prior content was a code block]\n\`\`\`\n${prevChunk.content}\n\`\`\`\n\n`
        : `[Prior passage — for context only]\n${prevChunk.content}\n\n`
    : ''

  const isCodeChunk = chunk.chunkType === 'code'
  const passageBlock = isCodeChunk
    ? `[Code sample from "${docLabel}"]\n\`\`\`${chunk.language !== 'en' ? chunk.language : ''}\n${chunk.content}\n\`\`\``
    : `[Passage from "${docLabel}"]\n${chunk.content}`

  // Build suggested card types description
  const suggestedTypes = strategy?.cardTypes ?? ['reflect', 'discover', 'raw_commentary']
  const typeDescriptions = suggestedTypes
    .map((t) => `  - ${CARD_TYPE_DESCRIPTIONS[t] ?? t}`)
    .join('\n')

  const codeInstructions = isCodeChunk
    ? `
CODE-SPECIFIC INSTRUCTIONS:
- This is a code sample, not prose. Focus on what the code does, key patterns, and concepts.
- For "discover" cards: highlight what technique or pattern the code demonstrates.
- For "reflect" cards: ask about when/why to use this approach, trade-offs, or alternatives.
- For "raw_commentary" cards: explain what the code does in plain language, note any gotchas.
- Include short inline code snippets in card text using backticks where helpful.
- Do NOT reproduce the entire code block in the card — summarize and reference key parts.
`
    : ''

  return `${contextBlock}${passageBlock}

You are a reading companion AI. Analyze the ${isCodeChunk ? 'code sample' : 'passage'} above and generate reading cards.

SUGGESTED CARD TYPES (you may adjust based on the content):
${typeDescriptions}
${codeInstructions}
INSTRUCTIONS:
1. First, understand what kind of content this is (prose, reference table, notation, formula, code sample, etc.).
2. Decide which card types actually make sense for this content. You may:
   - Skip card types that don't fit (e.g., don't write a "reflect" card for a symbol table)
   - Generate fewer cards if the content doesn't warrant all types
   - Generate no cards at all if the content is not meaningful enough (return empty array)
3. Format card text appropriately:
   - Use LaTeX notation (e.g., $x^2$, $\\sum_{i=1}^{n}$) for mathematical content
   - Use clean formatting for reference material (structured lists, tables)
   - Use natural prose for narrative content
   - Use backtick code spans for inline code references
4. Each card should be self-contained — a reader should understand it without seeing the original passage.

Respond with ONLY a JSON array. Each element has:
- "type": one of ${JSON.stringify(suggestedTypes)}
- "front": the card content (string, may include LaTeX or markdown)

Example: [{"type":"discover","front":"The key insight is..."},{"type":"reflect","front":"How might you..."}]
If no cards are appropriate, return: []

JSON:`
}
