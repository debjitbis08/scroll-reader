#!/usr/bin/env tsx
/**
 * Test TOC classification (AI + heuristic) on a document.
 *
 * Usage:
 *   pnpm --filter card-tester classify -- --file path/to/book.pdf
 *   pnpm --filter card-tester classify -- --file path/to/book.epub --heuristic
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { config } from 'dotenv'
import { extractToc, classifyToc, classifyTocHeuristic } from '@scroll-reader/pipeline'
import type { TocEntry, AIProvider, AIResponse, ImagePart, ExtractConfig } from '@scroll-reader/pipeline'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

config({ path: join(ROOT, '.env') })

const extractConfig: ExtractConfig = {
  extractorBin: process.env.EXTRACTOR_BIN || join(ROOT, 'packages/extractor/target/release/extractor'),
}

// ── CLI args ──

const args = process.argv.slice(2).filter(a => a !== '--')
const { values } = parseArgs({
  args,
  options: {
    file: { type: 'string' },
    heuristic: { type: 'boolean', default: false },
    provider: { type: 'string', default: 'gemini' },
    raw: { type: 'boolean', default: false },
  },
})

if (!values.file) {
  console.error('Usage: pnpm --filter card-tester classify -- --file path/to/book.pdf [--heuristic] [--raw] [--provider gemini|ollama]')
  process.exit(1)
}

const filePath = resolve(values.file)

// ── Extract TOC ──

console.log(`Extracting TOC from: ${filePath}`)
const toc = await extractToc(filePath, extractConfig)

if (toc.length === 0) {
  console.log('No table of contents found in this file.')
  process.exit(0)
}

console.log(`Found ${toc.length} TOC entries.\n`)

// ── Heuristic-only mode ──

if (values.heuristic) {
  const classification = classifyTocHeuristic(toc)
  printResult(toc, classification)
  process.exit(0)
}

// ── AI classification ──

function createProvider(): AIProvider {
  const name = values.provider ?? 'gemini'

  if (name === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY
    const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
    if (!apiKey) {
      console.error('GEMINI_API_KEY env var required')
      process.exit(1)
    }
    return {
      name: 'gemini',
      model,
      async generate(prompt: string, _images?: ImagePart[]): Promise<AIResponse> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        })
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
        const data = await res.json() as {
          candidates: { content: { parts: { text: string; thought?: boolean }[] } }[]
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
        }
        const parts = data.candidates[0].content.parts
        const text = (parts.filter((p) => !p.thought).pop() ?? parts[parts.length - 1]).text
        const um = data.usageMetadata
        return {
          text,
          usage: um ? {
            promptTokens: um.promptTokenCount ?? null,
            completionTokens: um.candidatesTokenCount ?? null,
            totalTokens: um.totalTokenCount ?? null,
            durationMs: null,
            raw: data.usageMetadata as Record<string, unknown>,
          } : null,
        }
      },
    }
  }

  if (name === 'ollama') {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    const model = process.env.OLLAMA_MODEL ?? 'mistral:7b'
    return {
      name: 'ollama',
      model,
      async generate(prompt: string): Promise<AIResponse> {
        const res = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: false }),
        })
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`)
        const data = await res.json() as { response: string }
        return { text: data.response, usage: null }
      },
    }
  }

  console.error(`Unknown provider: ${name}`)
  process.exit(1)
}

const provider = createProvider()
console.log(`Using provider: ${provider.name} (${provider.model})`)

if (values.raw) {
  // Raw mode: show exactly what the AI returns before any parsing
  const tocList = toc
    .map((entry, i) => `${i}. ${'  '.repeat(entry.level)}${entry.title}`)
    .join('\n')

  const prompt = `Classify each table-of-contents entry as "front", "main", or "back".

- "front" = frontmatter: title page, copyright, dedication, foreword, preface, acknowledgments, table of contents, epigraph, "also by", series page, half-title — material before the main body.
- "main" = main body content: chapters, parts, sections with substantive content. An introduction or prologue that contains actual content (not just a brief note) is "main".
- "back" = backmatter: appendix, bibliography, index, glossary, about the author, colophon, endnotes, references, further reading, permissions.

Entries are ordered as they appear in the document. Frontmatter entries always come before mainmatter. Backmatter entries always come after mainmatter.

Table of Contents:
${tocList}

Respond with ONLY a JSON array of ${toc.length} strings, one per entry in the same order. Example: ["front","front","main","main","back"]`

  console.log('\n--- PROMPT ---')
  console.log(prompt)
  console.log('\n--- RAW AI RESPONSE ---')
  const response = await provider.generate(prompt)
  console.log(response.text)
  console.log('\n--- END ---')
  if (response.usage) {
    console.log(`Tokens: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}`)
  }
  process.exit(0)
}

console.log('Classifying...\n')
const { classification, usage } = await classifyToc(toc, provider)

printResult(toc, classification)

if (usage) {
  console.log(`\nTokens: prompt=${usage.promptTokens}, completion=${usage.completionTokens}, total=${usage.totalTokens}`)
}

// Also show heuristic for comparison
console.log('\n--- Heuristic comparison ---\n')
const heuristic = classifyTocHeuristic(toc)
const diffs: number[] = []
for (let i = 0; i < toc.length; i++) {
  if (classification[i] !== heuristic[i]) diffs.push(i)
}

if (diffs.length === 0) {
  console.log('AI and heuristic agree on all entries.')
} else {
  console.log(`${diffs.length} difference(s):`)
  for (const i of diffs) {
    const indent = '  '.repeat(toc[i].level)
    console.log(`  ${String(i + 1).padStart(3)}. ${indent}${toc[i].title}`)
    console.log(`       AI: ${classification[i]}  |  Heuristic: ${heuristic[i]}`)
  }
}

// ── Output helper ──

function printResult(toc: TocEntry[], classification: string[]) {
  const COLORS: Record<string, string> = {
    front: '\x1b[90m',  // gray
    main: '\x1b[32m',   // green
    back: '\x1b[33m',   // yellow
  }
  const RESET = '\x1b[0m'

  for (let i = 0; i < toc.length; i++) {
    const entry = toc[i]
    const section = classification[i] ?? '?'
    const color = COLORS[section] ?? ''
    const indent = '  '.repeat(entry.level)
    const label = section.padEnd(5)
    console.log(`  ${String(i + 1).padStart(3)}. ${color}[${label}]${RESET} ${indent}${entry.title}`)
  }
}
