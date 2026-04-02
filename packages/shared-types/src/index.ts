export type CardType = 'discover' | 'connect' | 'raw_commentary' | 'flashcard' | 'quiz' | 'glossary' | 'contrast' | 'passage'

// --- Card content types (stored as JSONB in cards.content) ---

export type BodyContent = { body: string; title?: string }

export type FlashcardContent = { question: string; answer: string }

export type QuizContent = {
  question: string
  options: [string, string, string, string]
  correct: number
  explanations: [string, string, string, string]
}

export type GlossaryContent = {
  term: string
  definition: string
  etymology?: string
  related?: string[]
}

export type ContrastContent = {
  itemA: string
  itemB: string
  dimensions: string[]
  dimensionA: string[]
  dimensionB: string[]
}

export type PassageContent = { excerpt: string; commentary: string }

export type CardContent =
  | BodyContent
  | FlashcardContent
  | QuizContent
  | GlossaryContent
  | ContrastContent
  | PassageContent

export type DocumentType = 'book' | 'paper' | 'article' | 'manual' | 'note' | 'scripture' | 'other' | 'fiction'

export type ProcessingStatus = 'pending' | 'preview' | 'chunking' | 'generating' | 'ready' | 'error'

export type AIProvider = 'gemini' | 'ollama'

export type DocumentSource = 'desktop' | 'upload' | 'server' | 'catalog'

export type DocumentPriority = 'pinned' | 'active' | 'normal'

export type ChunkType = 'text' | 'image' | 'code'

export type Tier = 'free' | 'plus'

export type TierLimits = {
  storageBytes: number
  cardsPerDay: number
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: {
    storageBytes: 500 * 1024 * 1024, // 500 MB
    cardsPerDay: 100,
  },
  plus: {
    storageBytes: 5 * 1024 * 1024 * 1024, // 5 GB
    cardsPerDay: 500,
  },
}

export type FeedEventType = 'scrolled_past' | 'glanced' | 'engaged'

export type ReadingGoal = 'casual' | 'reflective' | 'study'

export type CardStrategy = {
  cardTypes: CardType[]
  chunkInterval: number // 1 = every chunk, 2 = every 2nd, 3 = every 3rd
}

export { resolveCardStrategy, describeStrategy } from './strategy.ts'

// Desktop-only: inbox flow
export type InboxStatus = 'discovered' | 'approved' | 'ignored'
