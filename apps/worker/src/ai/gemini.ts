import type { AIProvider } from './index.ts'

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>
    }
  }>
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const
  readonly model: string

  constructor() {
    this.model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
  }

  async generate(prompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    })

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as GeminiResponse
    return data.candidates[0].content.parts[0].text
  }
}
