import { callBin } from './bin-caller.ts'
import type { ChunkerConfig, ChunkerChunk, ChunkerSegment } from './types.ts'

export async function callChunker(text: string, config: ChunkerConfig): Promise<ChunkerChunk[]> {
  const out = await callBin(config.chunkerBin, { text }, 'chunker')
  return JSON.parse(out) as ChunkerChunk[]
}

export async function callSegmenter(text: string, config: ChunkerConfig): Promise<ChunkerSegment[]> {
  const out = await callBin(config.chunkerBin, { text, segment: true }, 'chunker')
  return JSON.parse(out) as ChunkerSegment[]
}
