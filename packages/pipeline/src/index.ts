// Types
export type {
  TextElement,
  ImageElement,
  CodeElement,
  DocElement,
  TocEntry,
  ChunkerChunk,
  ChunkerSegment,
  PipelineChunk,
  ImagePart,
  AIUsage,
  AIResponse,
  AIProvider,
  ExtractConfig,
  ChunkerConfig,
} from './types.ts'

// Extraction
export { extractDocument, extractToc, getPageCount } from './extract.ts'

// Filtering
export { filterByPageRange, filterByToc } from './filter.ts'

// Chunking
export { callChunker, callSegmenter } from './chunker.ts'

// AI chunking
export { aiChunk } from './ai-chunk.ts'
export type { AIChunkResult } from './ai-chunk.ts'

// Element transforms
export { mergeConsecutiveCode, foldSmallCodeIntoText } from './element-transforms.ts'
