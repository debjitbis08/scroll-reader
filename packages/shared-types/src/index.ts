export type CardType = 'discover' | 'connect' | 'raw_commentary' | 'sanskrit'

export type DocumentType = 'book' | 'paper' | 'article' | 'manual' | 'note' | 'scripture' | 'other' | 'fiction'

export type ProcessingStatus = 'pending' | 'preview' | 'chunking' | 'generating' | 'ready' | 'error'

export type AIProvider = 'gemini' | 'ollama'

export type DocumentSource = 'desktop' | 'upload' | 'server'

export type ChunkType = 'text' | 'image'

export type FeedEventType = 'view' | 'pause' | 'skip' | 'engage' | 'expand'

export type ReadingGoal = 'casual' | 'reflective' | 'study'

export type CardStrategy = {
  cardTypes: CardType[]
  chunkInterval: number // 1 = every chunk, 2 = every 2nd, 3 = every 3rd
}

export { resolveCardStrategy, describeStrategy } from './strategy.ts'

// Desktop-only: inbox flow
export type InboxStatus = 'discovered' | 'approved' | 'ignored'
