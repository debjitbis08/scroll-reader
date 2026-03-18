import type { AIProvider } from '../ai/index.ts'
import type { Document, Chunk, InsertCard } from '@scroll-reader/db'
import type { CardType } from '@scroll-reader/shared-types'
import { buildPrompt } from './prompts.ts'

// Card types generated in Phase 1 (self-hosted pipeline)
const PHASE1_CARD_TYPES: CardType[] = ['reflect', 'discover', 'raw_commentary']

/**
 * Generates one card of each Phase 1 type for the given text chunk.
 *
 * @param chunk     The text chunk to generate cards for
 * @param prevChunk Chunk N-1 from the DB (null for first chunk); used for context
 * @param doc       The parent document
 * @param provider  AI provider to call
 */
export async function generateCardsForChunk(
  chunk: Chunk,
  prevChunk: Chunk | null,
  doc: Document,
  provider: AIProvider,
  cardTypes: CardType[] = PHASE1_CARD_TYPES,
): Promise<InsertCard[]> {
  const results: InsertCard[] = []

  for (const cardType of cardTypes) {
    const prompt = buildPrompt(cardType, chunk, prevChunk, doc)
    const front = await provider.generate(prompt)

    results.push({
      userId: chunk.userId,
      chunkId: chunk.id,
      cardType,
      front: front.trim(),
      encrypted: false,
      aiProvider: provider.name,
      aiModel: provider.model,
    })
  }

  return results
}
