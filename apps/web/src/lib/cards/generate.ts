import type { AIProvider, AIUsage, ImagePart } from '../ai/index.ts'
import type { Document, Chunk, InsertCard } from '@scroll-reader/db'
import type { CardType, CardStrategy, CardContent, DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import { buildSmartPrompt } from './prompts.ts'

interface AICard {
  type: CardType
  content: CardContent
}

export interface CardGenResult {
  cards: InsertCard[]
  usage: AIUsage | null
}

/**
 * Generates cards for a chunk using a single intelligent AI call.
 * The AI analyzes the content, decides which card types make sense,
 * formats appropriately (LaTeX for math, etc.), and may produce
 * fewer cards or no cards if the content doesn't warrant them.
 *
 * The strategy is passed as a suggestion — the AI makes the final call.
 */
export async function generateCardsForChunk(
  chunk: Chunk,
  prevChunk: Chunk | null,
  doc: Document,
  provider: AIProvider,
  cardTypes?: CardType[],
  images?: { base64: string; mimeType: string; alt: string }[],
): Promise<CardGenResult> {
  const strategy: CardStrategy = cardTypes
    ? { cardTypes, chunkInterval: 1 }
    : resolveCardStrategy(
        (doc.documentType ?? 'other') as DocumentType,
        (doc.readingGoal ?? 'reflective') as ReadingGoal,
      )

  const imageAlts = images?.map((img) => img.alt)
  const imageParts: ImagePart[] | undefined = images?.map((img) => ({
    base64: img.base64,
    mimeType: img.mimeType,
  }))

  const prompt = buildSmartPrompt(chunk, prevChunk, doc, strategy, imageAlts)
  const response = await provider.generate(prompt, imageParts)
  const aiCards = parseAIResponse(response.text, strategy)

  return {
    cards: aiCards.map((card) => ({
      userId: chunk.userId,
      chunkId: chunk.id,
      cardType: card.type,
      content: card.content,
      encrypted: false,
      aiProvider: provider.name,
      aiModel: provider.model,
    })),
    usage: response.usage,
  }
}

function parseAIResponse(
  response: string,
  strategy: CardStrategy | null,
): AICard[] {
  // Extract JSON from response — handle markdown code fences
  const cleaned = response
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim()

  // AI models output LaTeX like \times, \theta, \frac, \beta, \nabla inside
  // JSON strings. JSON.parse treats \t as tab, \b as backspace, \f as
  // form-feed, \n as newline, \r as CR — corrupting LaTeX commands.
  // Strategy: escape all backslashes, then restore the valid JSON escapes
  // that aren't part of LaTeX (e.g. actual newlines between JSON fields).
  // AI models output LaTeX like \times, \theta, \frac, \beta, \nabla inside
  // JSON strings. JSON.parse treats \t as tab, \b as backspace, etc.
  // Strategy: protect known JSON escapes (\\, \", \/, \uXXXX), then escape
  // all remaining backslashes so LaTeX survives. We intentionally do NOT
  // protect \n, \r, \t here — they're ambiguous with LaTeX (\nabla, \rho,
  // \theta). The renderer handles literal \n in the output (see LatexText).
  const escaped = cleaned
    .replace(/\\\\/g, '\x00DOUBLE\x00')       // protect already-escaped \\
    .replace(/\\"/g, '\x00QUOTE\x00')          // protect \"
    .replace(/\\\//g, '\x00SLASH\x00')         // protect \/
    .replace(/\\u([0-9a-fA-F]{4})/g, '\x00U$1\x00') // protect \uXXXX
    .replace(/\\/g, '\\\\')                    // escape all remaining backslashes (LaTeX)
    .replace(/\x00DOUBLE\x00/g, '\\\\')        // restore \\
    .replace(/\x00QUOTE\x00/g, '\\"')          // restore \"
    .replace(/\x00SLASH\x00/g, '\\/')          // restore \/
    .replace(/\x00U([0-9a-fA-F]{4})\x00/g, '\\u$1') // restore \uXXXX

  let cards: unknown[]

  try {
    cards = JSON.parse(escaped)
  } catch {
    // Try to find a JSON array anywhere in the response
    const match = escaped.match(/\[[\s\S]*\]/)
    if (match) {
      try {
        cards = JSON.parse(match[0])
      } catch {
        console.warn('[card-gen] Could not parse AI response as JSON')
        return []
      }
    } else {
      return []
    }
  }

  if (!Array.isArray(cards)) return []

  const validTypes = new Set<string>(
    strategy?.cardTypes ?? ['discover', 'raw_commentary'],
  )

  return cards.filter((card): card is AICard => {
    if (!card || typeof card !== 'object') return false
    const c = card as Record<string, unknown>
    if (typeof c.type !== 'string' || !validTypes.has(c.type)) return false
    if (!c.content || typeof c.content !== 'object') return false
    return true
  })
}
