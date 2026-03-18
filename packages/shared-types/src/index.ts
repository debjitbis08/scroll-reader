export type CardType = 'reflect' | 'discover' | 'connect' | 'raw_commentary' | 'sanskrit'

export type DocumentType = 'book' | 'paper' | 'article' | 'manual' | 'note' | 'scripture' | 'other'

export type ProcessingStatus = 'pending' | 'preview' | 'chunking' | 'generating' | 'ready' | 'error'

export type AIProvider = 'gemini' | 'ollama'

export type DocumentSource = 'desktop' | 'upload' | 'server'

export type ChunkType = 'text' | 'image'

export type FeedEventType = 'view' | 'pause' | 'skip' | 'engage' | 'expand'

// Desktop-only: inbox flow
export type InboxStatus = 'discovered' | 'approved' | 'ignored'
