// ── Document elements (output of extraction) ──

export interface TextElement {
  type: 'text'
  content: string
  chapter?: string
  spine_index?: number
  anchor_id?: string
}

export interface ImageElement {
  type: 'image'
  alt: string
  file?: string
  mime?: string
  spine_index?: number
  anchor_id?: string
}

export interface CodeElement {
  type: 'code'
  content: string
  language?: string
  chapter?: string
  spine_index?: number
  anchor_id?: string
}

export type DocElement = TextElement | ImageElement | CodeElement

// ── Table of contents ──

export interface TocEntry {
  title: string
  page: number
  level: number
  fragment?: string
}

// ── Chunker binary output ──

export interface ChunkerChunk {
  content: string
  word_count: number
  chunk_index: number
  chapter: string | null
  language: string
}

export interface ChunkerSegment {
  content: string
  word_count: number
  segment_index: number
  chapter: string | null
  language: string
  is_chapter_start: boolean
}

// ── Pipeline chunk (intermediate representation used across consumers) ──

export interface PipelineChunk {
  content: string
  chapter: string | null
  chunkType: 'text' | 'code'
  wordCount: number
  language: string
  images: { file: string; alt: string; mime: string }[]
}

// ── AI provider interface (consumers provide implementations) ──

export interface ImagePart {
  mimeType: string
  base64: string
}

export interface AIUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  durationMs: number | null
  raw?: Record<string, unknown>
}

export interface AIResponse {
  text: string
  usage: AIUsage | null
}

export interface AIProvider {
  readonly name: 'gemini' | 'ollama'
  readonly model: string
  generate(prompt: string, images?: ImagePart[]): Promise<AIResponse>
}

// ── Config objects (injected by consumers) ──

export interface ExtractConfig {
  extractorBin: string
  figureExtractBin?: string
}

export interface ChunkerConfig {
  chunkerBin: string
}
