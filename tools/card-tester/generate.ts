#!/usr/bin/env tsx
/**
 * Generate cards from chunks.json → cards.json
 *
 * Usage:
 *   pnpm --filter card-tester generate [-- --type book --goal study --dir ./test-output]
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
import type {
  CardType,
  CardStrategy,
  CardContent,
  DocumentType,
  ReadingGoal,
} from '@scroll-reader/shared-types'
import { resolveCardStrategy } from '@scroll-reader/shared-types'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

// Load .env from workspace root
config({ path: join(ROOT, '.env') })

// ── CLI args ──

const args = process.argv.slice(2).filter(a => a !== '--')
const { values } = parseArgs({
  args,
  options: {
    type: { type: 'string', default: 'book' },
    goal: { type: 'string', default: 'study' },
    dir: { type: 'string', default: join(HERE, 'test-output') },
    provider: { type: 'string', default: 'gemini' },
  },
})

const outDir = resolve(values.dir!)
const chunksPath = join(outDir, 'chunks.json')
const cardsPath = join(outDir, 'cards.json')

// ── Load chunks ──

interface TestChunk {
  content: string
  chapter: string | null
  chunkType: 'text' | 'code'
  wordCount: number
  language: string
  images: { file: string; alt: string; mime: string }[]
}

let chunks: TestChunk[]
try {
  chunks = JSON.parse(await readFile(chunksPath, 'utf-8'))
} catch {
  console.error(`Could not read ${chunksPath}. Run "extract" first.`)
  process.exit(1)
}

console.log(`Loaded ${chunks.length} chunks from ${chunksPath}`)

// ── Strategy ──

const strategy = resolveCardStrategy(
  values.type as DocumentType,
  values.goal as ReadingGoal,
)

console.log(`Strategy: ${values.type}/${values.goal} → [${strategy.cardTypes.join(', ')}] every ${strategy.chunkInterval} chunk(s)`)

// ── AI Provider (standalone, no Astro deps) ──

interface ImagePart {
  mimeType: string
  base64: string
}

interface AIProvider {
  name: string
  model: string
  generate(prompt: string, images?: ImagePart[]): Promise<string>
}

function createProvider(): AIProvider {
  const name = values.provider ?? 'gemini'

  if (name === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    if (!apiKey) {
      console.error('GEMINI_API_KEY env var required')
      process.exit(1)
    }
    return {
      name: 'gemini',
      model,
      async generate(prompt: string, images?: ImagePart[]): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

        // Build multimodal parts: text prompt + inline images
        const parts: Record<string, unknown>[] = [{ text: prompt }]
        if (images) {
          for (const img of images) {
            parts.push({
              inline_data: {
                mime_type: img.mimeType,
                data: img.base64,
              },
            })
          }
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts }] }),
        })
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
        const data = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] }
        return data.candidates[0].content.parts[0].text
      },
    }
  }

  if (name === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    const model = process.env.OLLAMA_MODEL ?? 'mistral:7b'
    return {
      name: 'ollama',
      model,
      async generate(prompt: string, images?: ImagePart[]): Promise<string> {
        const body: Record<string, unknown> = { model, prompt, stream: false }
        // Ollama supports images for multimodal models (llava, etc.)
        if (images && images.length > 0) {
          body.images = images.map((img) => img.base64)
        }
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
        const data = await res.json() as { response: string }
        return data.response
      },
    }
  }

  console.error(`Unknown provider: ${name}`)
  process.exit(1)
}

// ── Prompt builder (standalone copy from apps/web/src/lib/cards/prompts.ts) ──

const CARD_TYPE_DESCRIPTIONS: Record<string, string> = {
  discover: 'Discover — distill the core idea or argument of the passage into a vivid, self-contained summary. The reader should come away understanding what the passage says and why it matters. Use multiple paragraphs separated by \\n\\n when the idea has distinct parts. Optionally include a short, evocative title (3-6 words).',
  raw_commentary: 'Notes — a sharp marginal note: question an assumption, surface a tension, connect to a broader idea, or reframe what the passage takes for granted. Opinionated and specific, not a summary. Use multiple paragraphs if needed.',
  connect: 'Connect — links this passage to ideas from elsewhere in the book or other works.',
  flashcard: 'Flashcard — a question about the transferable concept or principle illustrated in the passage, NOT about specific datasets, examples, or named entities used to explain it. Ask about the underlying idea ("What is the purpose of principal components?") not the example ("What did they do with the NCI60 dataset?"). Answer should be 1-3 sentences.',
  quiz: 'Quiz — a multiple choice question about a transferable concept or principle, with exactly 4 options (A-D), one correct answer (0-indexed), and a brief explanation for each option. Frame questions around the general idea, not specific examples or datasets from the text.',
  glossary: 'Glossary — a key term from the passage with its definition as used in this text, optional etymology or origin, and optionally related terms. If the term appears in a non-Latin script (e.g. Devanagari, Greek, Arabic) in the source, the term field MUST include the original script followed by the transliteration, e.g. "राजा (rājā)".',
  contrast: 'Contrast — an "X vs Y" comparison of two concepts, methods, or ideas mentioned or implied in the passage. Present 2-4 key dimensions of difference.',
  passage: 'Passage — select the most beautiful, significant, or thought-provoking excerpt from the passage. Reproduce it verbatim. Add only a brief (1 sentence) note on why it matters.',
}

function buildPrompt(
  chunk: TestChunk,
  prevChunk: TestChunk | null,
  docTitle: string,
  strategy: CardStrategy,
): string {
  const contextBlock = prevChunk
    ? prevChunk.chunkType === 'code'
      ? `[Prior content was a code block]\n\`\`\`\n${prevChunk.content}\n\`\`\`\n\n`
      : `[Prior passage — for context only]\n${prevChunk.content}\n\n`
    : ''

  const isCodeChunk = chunk.chunkType === 'code'
  const passageBlock = isCodeChunk
    ? `[Code sample from "${docTitle}"]\n\`\`\`${chunk.language !== 'en' ? chunk.language : ''}\n${chunk.content}\n\`\`\``
    : `[Passage from "${docTitle}"]\n${chunk.content}`

  const typeDescriptions = strategy.cardTypes
    .map((t) => `  - ${CARD_TYPE_DESCRIPTIONS[t] ?? t}`)
    .join('\n')

  const codeInstructions = isCodeChunk
    ? `
CODE-SPECIFIC INSTRUCTIONS:
- This is a code sample, not prose. Focus on what the code does, key patterns, and concepts.
- For "discover" cards: highlight what technique or pattern the code demonstrates.
- For "raw_commentary" cards: explain what the code does in plain language, note any gotchas.
- Include a SHORT, simplified code example (a few lines) using fenced code blocks (\`\`\`lang) that demonstrates the core idea — do not reproduce the original verbatim, create a minimal example inspired by it.
- Use backtick code spans for inline references to functions, variables, or keywords.
`
    : ''

  const hasImages = chunk.images.length > 0
  const imageList = hasImages
    ? chunk.images.map((img, i) => `  [${i}] ${img.alt}`).join('\n')
    : ''
  const imageInstructions = hasImages
    ? `\nThis passage has ${chunk.images.length} associated figure(s) attached as images below. You can see them. The figures are indexed as:
${imageList}
`
    : ''

  return `You are an expert reading companion that creates flashcards, quiz questions, and study materials from book passages.

${contextBlock}${passageBlock}
${codeInstructions}${imageInstructions}
SUGGESTED CARD TYPES (you may adjust based on the content):
${typeDescriptions}

INSTRUCTIONS:
1. First, understand what kind of content this is (prose, reference table, notation, formula, code sample, etc.).
2. ALWAYS generate a "discover" card first if it is in the suggested types — it is the primary card type. Then add other types only if the content warrants them.
3. You may skip non-discover card types that don't fit, generate fewer cards, or return an empty array if the content is not meaningful enough.
4. Format card text appropriately:
   - Use LaTeX notation (e.g., $x^2$, $\\sum_{i=1}^{n}$) for mathematical content. Put significant equations on their own line using $$...$$ display math. For long equations that won't fit on one line, use \\begin{aligned}...\\end{aligned} inside $$...$$ with \\\\ line breaks and & alignment points.
   - Use clean formatting for reference material (structured lists, tables)
   - IMPORTANT: If the source contains non-Latin scripts (Devanagari, Greek, Arabic, Chinese, etc.), you MUST include the original script in the card, not just transliterations. Write terms as "राजा (rājā)" not just "rājā". This applies to all card types — discover body, glossary terms, flashcard answers, etc.
   - Use natural prose for narrative content. Separate distinct ideas into multiple paragraphs using \\n\\n.
   - Use backtick code spans for inline code references. For multi-line code, you MUST use fenced code blocks with triple backticks and a language tag — write them as \`\`\`python\\n...code...\\n\`\`\` inside the JSON string. Never write a bare language name on its own line without the triple backticks.
5. SHOW, DON'T TELL: If the passage teaches through examples (code snippets, calculations, derivations, worked problems, formulas in action), the card MUST also teach through examples. Do NOT replace concrete examples with prose descriptions of what the examples do. Instead, create a SHORT, SIMPLIFIED example inspired by the original (a few lines of code, 2-3 steps of a calculation, a compact derivation). A brief sentence of context is fine, but the example is the core of the card. Prose-heavy summaries of example-driven content are a failure mode — avoid them.
6. FIGURES: If figures are attached above, you MUST include an "images" array on the primary "discover" card with the indices of figures that help explain the concept. Diagrams, plots, charts, and illustrations are almost always worth including. However, do NOT include figures that are just equations, formulas, or tables of numbers — reproduce those as LaTeX instead. Only include truly graphical images (diagrams, plots, charts, photos, illustrations, graphs, flowcharts).
7. CRITICAL — every card MUST be completely self-contained. The reader will see the card WITHOUT the source passage. Never write "the passage", "the text", "the author", "according to the passage", or "this section". Instead, name the specific concept, book, author, or idea directly. Include enough context that the card makes sense on its own.

Respond with ONLY a JSON array. Each element has "type" and "content" (an object whose shape depends on the type):

For "discover", "raw_commentary", "connect":
  {"type":"discover", "content": {"body":"Brief context.\\n\\n\`\`\`python\\nx = [1, 2, 3]\\nprint(sum(x))\\n\`\`\`\\n\\nExplanation of what this shows.", "images":[0]}}

For "flashcard":
  {"type":"flashcard", "content": {"question":"What is...?", "answer":"It is...", "images":[0]}}

For "quiz":
  {"type":"quiz", "content": {"question":"Which of...?", "options":["A","B","C","D"], "correct":0, "explanations":["Why A","Why B","Why C","Why D"], "images":[0]}}

For "glossary":
  {"type":"glossary", "content": {"term":"Term", "definition":"Definition", "etymology":"Origin (optional)", "related":["term1","term2"]}}

For "contrast":
  {"type":"contrast", "content": {"itemA":"X", "itemB":"Y", "dimensions":["dim1","dim2"], "dimensionA":["x1","x2"], "dimensionB":["y1","y2"], "images":[0,1]}}

For "passage":
  {"type":"passage", "content": {"excerpt":"Verbatim text...", "commentary":"Why it matters."}}

The "images" array is OPTIONAL on all types — only include it when figures are relevant to that specific card. Glossary cards typically don't need figures.

ALLOWED TYPES: ${strategy.cardTypes.join(', ')}

JSON:`
}

// ── AI response parser (from apps/web/src/lib/cards/generate.ts) ──

interface AICard { type: CardType; content: CardContent }

function parseResponse(response: string, strategy: CardStrategy): AICard[] {
  const cleaned = response.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

  const escaped = cleaned
    .replace(/\\\\/g, '\x00DOUBLE\x00')
    .replace(/\\"/g, '\x00QUOTE\x00')
    .replace(/\\\//g, '\x00SLASH\x00')
    .replace(/\\u([0-9a-fA-F]{4})/g, '\x00U$1\x00')
    .replace(/\\/g, '\\\\')
    .replace(/\x00DOUBLE\x00/g, '\\\\')
    .replace(/\x00QUOTE\x00/g, '\\"')
    .replace(/\x00SLASH\x00/g, '\\/')
    .replace(/\x00U([0-9a-fA-F]{4})\x00/g, '\\u$1')

  let cards: unknown[]
  try {
    cards = JSON.parse(escaped)
  } catch {
    const match = escaped.match(/\[[\s\S]*\]/)
    if (match) {
      try { cards = JSON.parse(match[0]) } catch { return [] }
    } else {
      return []
    }
  }

  if (!Array.isArray(cards)) return []
  const validTypes = new Set<string>(strategy.cardTypes)

  return cards.filter((card): card is AICard => {
    if (!card || typeof card !== 'object') return false
    const c = card as Record<string, unknown>
    return typeof c.type === 'string' && validTypes.has(c.type) && !!c.content && typeof c.content === 'object'
  })
}

// ── Generate ──

const provider = createProvider()
const docTitle = 'Test Document'
const interval = strategy.chunkInterval

const textChunks = chunks.filter((c) => c.chunkType === 'text' || c.chunkType === 'code')
const eligibleChunks = interval > 1
  ? textChunks.filter((_, i) => i % interval === 0)
  : textChunks

console.log(`Eligible chunks: ${eligibleChunks.length} (of ${textChunks.length} text/code chunks)`)

interface TestCard {
  cardType: string
  content: CardContent
  chunkIndex: number
  chunk: { content: string; chapter: string | null; images: TestChunk['images'] }
}

const allCards: TestCard[] = []

for (let i = 0; i < eligibleChunks.length; i++) {
  const chunk = eligibleChunks[i]
  const chunkIndex = chunks.indexOf(chunk)
  const prevChunk = chunkIndex > 0 ? chunks[chunkIndex - 1] : null

  const imgCount = chunk.images.length
  process.stdout.write(`  Generating cards for chunk ${i + 1}/${eligibleChunks.length}${imgCount > 0 ? ` (${imgCount} image${imgCount > 1 ? 's' : ''})` : ''}...`)

  try {
    const prompt = buildPrompt(chunk, prevChunk, docTitle, strategy)

    // Load images from disk for multimodal
    const imageParts: ImagePart[] = []
    for (const img of chunk.images) {
      try {
        const imgPath = join(outDir, img.file)
        const buffer = await readFile(imgPath)
        imageParts.push({
          mimeType: img.mime,
          base64: buffer.toString('base64'),
        })
      } catch {
        // Image file not found — skip
      }
    }

    const response = await provider.generate(prompt, imageParts.length > 0 ? imageParts : undefined)
    const cards = parseResponse(response, strategy)

    for (const card of cards) {
      allCards.push({
        cardType: card.type,
        content: card.content,
        chunkIndex,
        chunk: {
          content: chunk.content,
          chapter: chunk.chapter,
          images: chunk.images,
        },
      })
    }

    console.log(` ${cards.length} cards (${cards.map((c) => c.type).join(', ')})`)
  } catch (err) {
    console.log(` ERROR: ${(err as Error).message}`)
  }
}

await writeFile(cardsPath, JSON.stringify(allCards, null, 2))

// Summary
const typeCounts = new Map<string, number>()
for (const c of allCards) typeCounts.set(c.cardType, (typeCounts.get(c.cardType) ?? 0) + 1)

console.log(`\nDone! ${allCards.length} cards written to ${cardsPath}`)
console.log('  Types:', [...typeCounts.entries()].map(([t, n]) => `${t}: ${n}`).join(', '))
