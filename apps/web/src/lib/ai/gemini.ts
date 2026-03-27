import type { AIProvider, ImagePart } from './index.ts'
import { GEMINI_MODEL, GEMINI_API_KEY } from 'astro:env/server'

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
    this.model = GEMINI_MODEL
  }

  async generate(prompt: string, images?: ImagePart[]): Promise<string> {
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
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    })

    if (!res.ok) {
      throw new Error(`Gemini API error ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as GeminiResponse
    return data.candidates[0].content.parts[0].text
  }
}
