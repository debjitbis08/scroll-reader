import type { Document, Chunk } from '@scroll-reader/db'
import type { CardType, CardStrategy } from '@scroll-reader/shared-types'

const CARD_TYPE_DESCRIPTIONS: Record<CardType, string> = {
  discover: 'Discover — distill the core idea or argument of the passage into a vivid, self-contained summary. The reader should come away understanding what the passage says and why it matters. 2-4 sentences. Optionally include a short, evocative title (3-6 words).',
  raw_commentary: 'Notes — a sharp marginal note: question an assumption, surface a tension, connect to a broader idea, or reframe what the passage takes for granted. Opinionated and specific, not a summary. 1-3 sentences.',
  connect: 'Connect — links this passage to ideas from elsewhere in the book or other works.',
  flashcard: 'Flashcard — a question about the transferable concept or principle illustrated in the passage, NOT about specific datasets, examples, or named entities used to explain it. Ask about the underlying idea ("What is the purpose of principal components?") not the example ("What did they do with the NCI60 dataset?"). Answer should be 1-3 sentences.',
  quiz: 'Quiz — a multiple choice question about a transferable concept or principle, with exactly 4 options (A-D), one correct answer (0-indexed), and a brief explanation for each option. Frame questions around the general idea, not specific examples or datasets from the text.',
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
2. ALWAYS generate a "discover" card first if it is in the suggested types — it is the primary card type. Then add other types only if the content warrants them.
3. You may skip non-discover card types that don't fit, generate fewer cards, or return an empty array if the content is not meaningful enough.
4. Format card text appropriately:
   - Use LaTeX notation (e.g., $x^2$, $\\sum_{i=1}^{n}$) for mathematical content
   - Use clean formatting for reference material (structured lists, tables)
   - Use natural prose for narrative content
   - Use backtick code spans for inline code references
5. CRITICAL — every card MUST be completely self-contained. The reader will see the card WITHOUT the source passage. Never write "the passage", "the text", "the author", "according to the passage", or "this section". Instead, name the specific concept, book, author, or idea directly. Include enough context that the card makes sense on its own.

Respond with ONLY a JSON array. Each element has "type" and "content" (an object whose shape depends on the type):

For "discover", "raw_commentary", "connect":
  {"type":"discover", "content": {"title":"Optional Short Title", "body":"The key insight is..."}}

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
