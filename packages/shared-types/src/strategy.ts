import type { CardStrategy, CardType, DocumentType, ReadingGoal } from './index.ts'

type StrategyKey = `${DocumentType}:${ReadingGoal}`

const STRATEGY_MAP: Record<string, CardStrategy> = {
  // Fiction
  'fiction:casual':     { cardTypes: [],                                    chunkInterval: 1 },
  'fiction:reflective': { cardTypes: ['discover'],                          chunkInterval: 3 },
  'fiction:study':      { cardTypes: ['discover'],                          chunkInterval: 2 },

  // Spiritual / scripture
  'scripture:casual':     { cardTypes: ['discover'],                        chunkInterval: 3 },
  'scripture:reflective': { cardTypes: ['discover', 'raw_commentary'],      chunkInterval: 1 },
  'scripture:study':      { cardTypes: ['discover', 'raw_commentary'],      chunkInterval: 1 },

  // Non-fiction (book, article, paper, note, other)
  'book:casual':     { cardTypes: ['discover'],                             chunkInterval: 3 },
  'book:reflective': { cardTypes: ['discover'],                             chunkInterval: 2 },
  'book:study':      { cardTypes: ['discover', 'raw_commentary'],           chunkInterval: 1 },

  // Textbook / technical / manual
  'manual:casual':     { cardTypes: ['discover'],                           chunkInterval: 2 },
  'manual:reflective': { cardTypes: ['discover'],                           chunkInterval: 1 },
  'manual:study':      { cardTypes: ['discover', 'raw_commentary'],         chunkInterval: 1 },
}

// Document types that map to 'book' strategy (general non-fiction)
const NON_FICTION_ALIASES: DocumentType[] = ['book', 'paper', 'article', 'note', 'other']

export function resolveCardStrategy(
  documentType: DocumentType,
  readingGoal: ReadingGoal,
): CardStrategy {
  const effectiveType = NON_FICTION_ALIASES.includes(documentType) ? 'book' : documentType
  const key: StrategyKey = `${effectiveType}:${readingGoal}`
  return STRATEGY_MAP[key] ?? { cardTypes: ['discover', 'raw_commentary'], chunkInterval: 1 }
}

/** Human-readable summary for the UI preview */
export function describeStrategy(strategy: CardStrategy): string {
  if (strategy.cardTypes.length === 0) return 'No cards — reading mode only'

  const LABELS: Record<CardType, string> = {
    discover: 'Discover',
    raw_commentary: 'Notes',
    connect: 'Connect',
    sanskrit: 'Sanskrit',
  }

  const types = strategy.cardTypes.map((t) => LABELS[t]).join(' + ')
  const interval =
    strategy.chunkInterval === 1 ? 'every passage' :
    strategy.chunkInterval === 2 ? 'every 2nd passage' :
    `every ${strategy.chunkInterval}${strategy.chunkInterval === 3 ? 'rd' : 'th'} passage`

  return `${types} cards, ${interval}`
}
