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

function resolveChunkerBin(): string {
  if (CHUNKER_BIN) return CHUNKER_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../../packages/chunker/target/debug/chunker')
}

export async function callChunker(text: string): Promise<ChunkerChunk[]> {
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
        resolve(JSON.parse(stdout) as ChunkerChunk[])
      } catch {
        reject(new Error(`chunker output is not valid JSON: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn chunker at "${binPath}": ${err.message}`))
    })

    proc.stdin.write(JSON.stringify({ text }))
    proc.stdin.end()
  })
}
