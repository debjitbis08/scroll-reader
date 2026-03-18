import type { AIProvider } from './index.ts'

interface OllamaResponse {
  response: string
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const
  readonly model: string
  private readonly baseUrl: string

  constructor() {
    this.model = process.env.OLLAMA_MODEL ?? 'mistral:7b'
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
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
