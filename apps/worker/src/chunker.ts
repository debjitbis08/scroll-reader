import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import type { ChunkerChunk } from './types.ts'

// Resolve default binary path relative to this file's location.
// In dev: packages/chunker/target/debug/chunker
// Override via CHUNKER_BIN env var for production builds.
function resolveChunkerBin(): string {
  if (process.env.CHUNKER_BIN) return process.env.CHUNKER_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../packages/chunker/target/debug/chunker')
}

/**
 * Calls the chunker binary via stdin/stdout JSON protocol.
 * Input:  { text: string, options?: { min_words, max_words } }
 * Output: ChunkerChunk[]
 */
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
      reject(new Error(`Failed to spawn chunker binary at "${binPath}": ${err.message}`))
    })

    proc.stdin.write(JSON.stringify({ text }))
    proc.stdin.end()
  })
}
