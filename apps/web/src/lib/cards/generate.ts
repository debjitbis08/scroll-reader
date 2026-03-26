import type { AIProvider } from '../ai/index.ts'
import type { Document, Chunk, InsertCard } from '@scroll-reader/db'
import type { CardType, CardStrategy, CardContent, DocumentType, ReadingGoal } from '@scroll-reader/shared-types'
import { resolveCardStrategy } from '@scroll-reader/shared-types'
import { buildSmartPrompt } from './prompts.ts'

interface AICard {
  type: CardType
  content: CardContent
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
): Promise<InsertCard[]> {
  const strategy: CardStrategy = cardTypes
    ? { cardTypes, chunkInterval: 1 }
    : resolveCardStrategy(
        (doc.documentType ?? 'other') as DocumentType,
        (doc.readingGoal ?? 'reflective') as ReadingGoal,
      )

  const prompt = buildSmartPrompt(chunk, prevChunk, doc, strategy)
  const response = await provider.generate(prompt)
  const aiCards = parseAIResponse(response, strategy)

  return aiCards.map((card) => ({
    userId: chunk.userId,
    chunkId: chunk.id,
    cardType: card.type,
    content: card.content,
    encrypted: false,
    aiProvider: provider.name,
    aiModel: provider.model,
  }))
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

  let cards: unknown[]

  try {
    cards = JSON.parse(cleaned)
  } catch {
    // Try to find a JSON array anywhere in the response
    const match = cleaned.match(/\[[\s\S]*\]/)
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
