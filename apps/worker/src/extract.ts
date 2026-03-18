import { readFile } from 'node:fs/promises'
import { extname, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { DocElement } from './types.ts'

function resolveExtractorBin(): string {
  if (process.env.EXTRACTOR_BIN) return process.env.EXTRACTOR_BIN
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../packages/extractor/target/debug/extractor')
}

/**
 * Extracts an ordered sequence of text and image elements from a document file.
 *
 *   .txt  — reads file directly (useful for testing without building the extractor)
 *   .epub — calls the Rust extractor binary
 *   .pdf  — calls the Rust extractor binary
 */
export async function extractDocument(filePath: string): Promise<DocElement[]> {
  const ext = extname(filePath).toLowerCase()

  if (ext === '.txt') {
    const content = await readFile(filePath, 'utf-8')
    return [{ type: 'text', content }]
  }

  if (ext === '.epub' || ext === '.pdf') {
    return callExtractor(filePath)
  }

  throw new Error(`[extract] Unsupported file type: ${ext}`)
}

async function callExtractor(filePath: string): Promise<DocElement[]> {
  const binPath = resolveExtractorBin()

  return new Promise((resolve, reject) => {
    const proc = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`extractor exited ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as DocElement[])
      } catch {
        reject(new Error(`extractor output is not valid JSON: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn extractor binary at "${binPath}": ${err.message}`))
    })

    proc.stdin.write(JSON.stringify({ file_path: filePath }))
    proc.stdin.end()
  })
}
