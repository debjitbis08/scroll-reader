import type { Document, Chunk } from "@scroll-reader/db";
import type { CardType, CardStrategy } from "@scroll-reader/shared-types";

const CARD_TYPE_DESCRIPTIONS: Record<CardType, string> = {
  discover:
    "Discover — distill the core idea or argument into a vivid, self-contained summary. Name the topic and explain what it is and why it matters — a reader with no other context should fully understand the card. Use multiple paragraphs separated by \\n\\n when the idea has distinct parts. Optionally include a short, evocative title (3-6 words).",
  raw_commentary:
    "Notes — a sharp marginal note: question an assumption, surface a tension, connect to a broader idea, or reframe what is taken for granted. Opinionated and specific, not a summary. Must make sense without any surrounding context. Use multiple paragraphs if needed.",
  connect:
    "Connect — links a concept here to ideas from elsewhere in the book or other works. Name both ideas explicitly.",
  flashcard:
    'Flashcard — a question about the transferable concept or principle, NOT about specific datasets, examples, or named entities. Ask about the underlying idea ("What is the purpose of principal components?") not a specific example ("What did they do with the NCI60 dataset?"). Answer should be 1-3 sentences.',
  quiz: "Quiz — a multiple choice question about a transferable concept or principle, with exactly 4 options (A-D), one correct answer (0-indexed), and a brief explanation for each option. Frame questions around the general idea, not specific examples or datasets.",
  glossary:
    'Glossary — a key term with its definition, optional etymology or origin, and optionally related terms. If the term appears in a non-Latin script (e.g. Devanagari, Greek, Arabic) in the source, the term field MUST include the original script followed by the transliteration, e.g. "राजा (rājā)".',
  contrast:
    'Contrast — an "X vs Y" comparison of two concepts, methods, or ideas. Name both explicitly. Present 2-4 key dimensions of difference.',
  passage:
    "Passage — select the most beautiful, significant, or thought-provoking excerpt. Reproduce it verbatim. Add only a brief (1 sentence) note on why it matters.",
};

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
  const docLabel = doc.title ?? "Untitled";

  const contextBlock = prevChunk
    ? prevChunk.chunkType === "image"
      ? `[Prior content was an image: ${prevChunk.content || "no alt text"}]\n\n`
      : prevChunk.chunkType === "code"
        ? `[Prior content was a code block]\n\`\`\`\n${prevChunk.content}\n\`\`\`\n\n`
        : `[Prior passage — for context only]\n${prevChunk.content}\n\n`
    : "";

  const isCodeChunk = chunk.chunkType === "code";
  const passageBlock = isCodeChunk
    ? `[Code sample from "${docLabel}"]\n\`\`\`${chunk.language !== "en" ? chunk.language : ""}\n${chunk.content}\n\`\`\``
    : `[Passage from "${docLabel}"]\n${chunk.content}`;

  // Build suggested card types description
  const suggestedTypes = strategy?.cardTypes ?? ["discover", "raw_commentary"];
  const typeDescriptions = suggestedTypes
    .map((t) => `  - ${CARD_TYPE_DESCRIPTIONS[t] ?? t}`)
    .join("\n");

  const codeInstructions = isCodeChunk
    ? `
CODE-SPECIFIC INSTRUCTIONS:
- This is a code sample, not prose. Focus on what the code does, key patterns, and concepts.
- For "discover" cards: highlight what technique or pattern the code demonstrates.
- For "raw_commentary" cards: explain what the code does in plain language, note any gotchas.
- Include a SHORT, simplified code example (a few lines) using fenced code blocks (\`\`\`lang) that demonstrates the core idea — do not reproduce the original verbatim, create a minimal example inspired by it.
- Use backtick code spans for inline references to functions, variables, or keywords.
`
    : "";

  return `${contextBlock}${passageBlock}

You are a reading companion AI. Analyze the ${isCodeChunk ? "code sample" : "passage"} above and generate reading cards.

SUGGESTED CARD TYPES (you may adjust based on the content):
${typeDescriptions}
${codeInstructions}
INSTRUCTIONS:
1. First, understand what kind of content this is (prose, reference table, notation, formula, code sample, exercises/questions, table of contents, etc.).
2. If the content TEACHES something (explains a concept, presents an argument, demonstrates a technique), generate a "discover" card first when it is in the suggested types — it is the primary card type. Then add other types only if the content warrants them.
3. If the content is primarily exercises, homework questions, discussion prompts, review questions, or a table of contents/index — do NOT generate a "discover" card. These are questions, not teachings. Instead, generate flashcard or quiz cards that ANSWER the most important questions if possible, or return an empty array if the questions are too open-ended or require external work.
4. If the content is meta-content about the document itself — a preface, foreword, introduction explaining the book's purpose/audience/structure, or an author's note — restrict to "discover" and "passage". Do NOT generate flashcard, quiz, or glossary cards for this content, as the subject matter is the book, not the field it covers.
5. You may skip any card type that doesn't fit, generate fewer cards, or return an empty array if the content is not meaningful enough.
5. Format card text appropriately:
   - Use LaTeX notation (e.g., $x^2$, $\\sum_{i=1}^{n}$) for mathematical content. Put significant equations on their own line using $$...$$ display math. For long equations that won't fit on one line, use \\begin{aligned}...\\end{aligned} inside $$...$$ with \\\\ line breaks and & alignment points.
   - Use clean formatting for reference material (structured lists, tables)
   - IMPORTANT: If the source contains non-Latin scripts (Devanagari, Greek, Arabic, Chinese, etc.), you MUST include the original script in the card, not just transliterations. Write terms as "राजा (rājā)" not just "rājā". This applies to all card types — discover body, glossary terms, flashcard answers, etc.
   - Use natural prose for narrative content. Separate distinct ideas into multiple paragraphs using \\n\\n.
   - Use backtick code spans for inline code references. For multi-line code, you MUST use fenced code blocks with triple backticks and a language tag — write them as \`\`\`python\\n...code...\\n\`\`\` inside the JSON string. Never write a bare language name on its own line without the triple backticks.
6. SHOW, DON'T TELL: If the passage teaches through examples (code snippets, calculations, derivations, worked problems, formulas in action), the card MUST also teach through examples. Do NOT replace concrete examples with prose descriptions of what the examples do. Instead, create a SHORT, SIMPLIFIED example inspired by the original (a few lines of code, 2-3 steps of a calculation, a compact derivation). A brief sentence of context is fine, but the example is the core of the card. Prose-heavy summaries of example-driven content are a failure mode — avoid them.
   - All examples in the card MUST use names, values, and expressions from the source text exactly as written. Do not invent new names, values, or examples.
7. ACCURACY — cards must faithfully represent what the source passage actually says. Do NOT hallucinate facts, invent examples, or substitute generic content. Every claim and example in the card must be traceable to the source passage. Reminder: all examples must be grounded in the source chunk. Do not substitute invented examples.
8. CRITICAL — every card MUST be completely self-contained. The reader will see the card WITHOUT the source text — they may never read it. Never open with or use phrases like "The passage…", "In this passage…", "This passage…", "The text…", "The author argues…", "According to the passage…", "This section…", "The excerpt…", or any phrasing that assumes the reader has just read something. Instead, lead with the subject itself: name the concept, the author (by name), the book, or the idea directly. Write as if you are explaining the topic to someone who has never seen the source material.

Respond with ONLY a JSON array. Each element has "type" and "content" (an object whose shape depends on the type):

For "discover", "raw_commentary", "connect":
  {"type":"discover", "content": {"title":"Optional Short Title", "body":"Brief context.\\n\\n\`\`\`python\\nx = [1, 2, 3]\\nprint(sum(x))\\n\`\`\`\\n\\nExplanation of what this shows."}}

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

JSON:`;
}
