import type { Document, Chunk } from '@scroll-reader/db'
import type { CardType, CardStrategy } from '@scroll-reader/shared-types'

const CARD_TYPE_DESCRIPTIONS: Record<CardType, string> = {
  discover: 'Discover — one surprising or illuminating insight from the passage that a reader would find worth sitting with. 2-3 sentences.',
  raw_commentary: 'Notes — a brief, direct marginal note, the kind a thoughtful reader scribbles in the margin. Specific to the text. 2-3 sentences.',
  connect: 'Connect — links this passage to ideas from elsewhere in the book or other works.',
  flashcard: 'Flashcard — a question testing a key concept from the passage, with a concise answer. Question should be specific and answerable. Answer should be 1-3 sentences.',
  quiz: 'Quiz — a multiple choice question with exactly 4 options (A-D), one correct answer (0-indexed), and a brief explanation for each option explaining why it is correct or incorrect.',
  glossary: 'Glossary — a key term from the passage with its definition as used in this text, optional etymology or origin, and optionally related terms.',
  contrast: 'Contrast — an "X vs Y" comparison of two concepts, methods, or ideas mentioned or implied in the passage. Present 2-4 key dimensions of difference.',
  passage: 'Passage — select the most beautiful, significant, or thought-provoking excerpt from the passage. Reproduce it verbatim. Add only a brief (1 sentence) note on why it matters.',
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
  const suggestedTypes = strategy?.cardTypes ?? ['discover', 'raw_commentary']
  const typeDescriptions = suggestedTypes
    .map((t) => `  - ${CARD_TYPE_DESCRIPTIONS[t] ?? t}`)
    .join('\n')

  const codeInstructions = isCodeChunk
    ? `
CODE-SPECIFIC INSTRUCTIONS:
- This is a code sample, not prose. Focus on what the code does, key patterns, and concepts.
- For "discover" cards: highlight what technique or pattern the code demonstrates.
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
   - Skip card types that don't fit (e.g., don't write a "discover" card for a symbol table)
   - Generate fewer cards if the content doesn't warrant all types
   - Generate no cards at all if the content is not meaningful enough (return empty array)
3. Format card text appropriately:
   - Use LaTeX notation (e.g., $x^2$, $\\sum_{i=1}^{n}$) for mathematical content
   - Use clean formatting for reference material (structured lists, tables)
   - Use natural prose for narrative content
   - Use backtick code spans for inline code references
4. Each card should be self-contained — a reader should understand it without seeing the original passage.

Respond with ONLY a JSON array. Each element has "type" and "content" (an object whose shape depends on the type):

For "discover", "raw_commentary", "connect":
  {"type":"discover", "content": {"body":"The key insight is..."}}

For "flashcard":
  {"type":"flashcard", "content": {"question":"What is...?", "answer":"It is..."}}

For "quiz":
  {"type":"quiz", "content": {"question":"Which of the following...?", "options":["A...","B...","C...","D..."], "correct":0, "explanations":["Why A...","Why B...","Why C...","Why D..."]}}

For "glossary":
  {"type":"glossary", "content": {"term":"Term", "definition":"Definition as used here", "etymology":"Optional origin", "related":["related1","related2"]}}

For "contrast":
  {"type":"contrast", "content": {"itemA":"Concept A", "itemB":"Concept B", "dimensions":["dim1","dim2","dim3"], "dimensionA":["A trait1","A trait2","A trait3"], "dimensionB":["B trait1","B trait2","B trait3"]}}

For "passage":
  {"type":"passage", "content": {"excerpt":"The verbatim excerpt...", "commentary":"Why this matters."}}

Allowed types: ${JSON.stringify(suggestedTypes)}
If no cards are appropriate, return: []

JSON:`
}
