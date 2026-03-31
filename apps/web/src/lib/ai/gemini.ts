import type { AIProvider, AIResponse, ImagePart } from './index.ts'
import { GEMINI_MODEL, GEMINI_API_KEY } from 'astro:env/server'

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>
    }
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    totalTokenCount?: number
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const
  readonly model: string

  constructor() {
    this.model = GEMINI_MODEL
  }

  async generate(prompt: string, images?: ImagePart[]): Promise<AIResponse> {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set')
    const apiKey = GEMINI_API_KEY

    const parts: Record<string, unknown>[] = [{ text: prompt }]
    if (images) {
      for (const img of images) {
        parts.push({
          inline_data: {
            mime_type: img.mimeType,
            data: img.base64,
          },
        })
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`
    const start = performance.now()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    })
    const durationMs = Math.round(performance.now() - start)

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as GeminiResponse
    const text = data.candidates[0].content.parts[0].text
    const um = data.usageMetadata

    return {
      text,
      usage: um ? {
        promptTokens: um.promptTokenCount ?? null,
        completionTokens: um.candidatesTokenCount ?? null,
        totalTokens: um.totalTokenCount ?? null,
        durationMs,
        raw: um.thoughtsTokenCount ? { thoughtsTokenCount: um.thoughtsTokenCount } : undefined,
      } : null,
    }
  }
}
