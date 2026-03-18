import type { AIProvider } from './index.ts'
import { OLLAMA_MODEL, OLLAMA_BASE_URL } from 'astro:env/server'

interface OllamaResponse {
  response: string
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const
  readonly model: string
  private readonly baseUrl: string

  constructor() {
    this.model = OLLAMA_MODEL
    this.baseUrl = OLLAMA_BASE_URL
  }

  async generate(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
    })

    if (!res.ok) {
      throw new Error(`Ollama API error ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as OllamaResponse
    return data.response
  }
}
