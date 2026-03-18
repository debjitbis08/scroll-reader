import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { CHUNKER_BIN } from 'astro:env/server'

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

function resolveChunkerBin(): string {
  if (CHUNKER_BIN) return CHUNKER_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../../packages/chunker/target/debug/chunker')
}

function callBinary<T>(input: Record<string, unknown>): Promise<T> {
  const binPath = resolveChunkerBin()

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`chunker exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as T)
      } catch {
        reject(new Error(`chunker output is not valid JSON: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn chunker at "${binPath}": ${err.message}`))
    })

    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

export async function callChunker(text: string): Promise<ChunkerChunk[]> {
  return callBinary<ChunkerChunk[]>({ text })
}

export async function callSegmenter(text: string): Promise<ChunkerSegment[]> {
  return callBinary<ChunkerSegment[]>({ text, segment: true })
}
