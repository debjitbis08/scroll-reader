import type { AIProvider, AIResponse, ImagePart } from './index.ts'
import { OLLAMA_MODEL, OLLAMA_BASE_URL } from 'astro:env/server'

interface OllamaResponse {
  response: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama' as const
  readonly model: string
  private readonly baseUrl: string

  constructor() {
    this.model = OLLAMA_MODEL
    this.baseUrl = OLLAMA_BASE_URL
  }

  async generate(prompt: string, images?: ImagePart[]): Promise<AIResponse> {
    const body: Record<string, unknown> = { model: this.model, prompt, stream: false }
    if (images && images.length > 0) {
      body.images = images.map((img) => img.base64)
    }
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(`Ollama API error ${res.status}: ${await res.text()}`)
    }

    const data = (await res.json()) as OllamaResponse
    const promptTokens = data.prompt_eval_count ?? null
    const completionTokens = data.eval_count ?? null

    return {
      text: data.response,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens != null && completionTokens != null
          ? promptTokens + completionTokens
          : null,
        durationMs: data.total_duration != null
          ? Math.round(data.total_duration / 1e6)
          : null,
        raw: {
          load_duration: data.load_duration,
          prompt_eval_duration: data.prompt_eval_duration,
          eval_duration: data.eval_duration,
        },
      },
    }
  }
}
