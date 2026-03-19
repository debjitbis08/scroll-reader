// Elements emitted by the document extractor in document order.
// Text blocks are batched and sent to the chunker binary.
// Image references become chunk_type='image' rows directly.
// Code blocks become chunk_type='code' rows (atomic, not chunked).

export interface TextElement {
  type: 'text'
  content: string
  chapter?: string
}

export interface ImageElement {
  type: 'image'
  alt: string
}

export interface CodeElement {
  type: 'code'
  content: string
  language?: string
  chapter?: string
}

export type DocElement = TextElement | ImageElement | CodeElement

// Output shape from the chunker binary (matches packages/chunker/src/lib.rs Chunk struct)
export interface ChunkerChunk {
  content: string
  word_count: number
  chunk_index: number
  chapter: string | null
  language: string
}
