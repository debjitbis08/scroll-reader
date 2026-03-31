import type { AIProvider, AIResponse } from './index.ts'

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
    this.model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  }

  async generate(prompt: string): Promise<AIResponse> {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`
    const start = performance.now()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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
