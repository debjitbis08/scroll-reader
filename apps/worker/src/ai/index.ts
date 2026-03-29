import { GeminiProvider } from './gemini.ts'
import { OllamaProvider } from './ollama.ts'

export interface AIUsage {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  durationMs: number | null
  raw?: Record<string, unknown>
}

export interface AIResponse {
  text: string
  usage: AIUsage | null
}

// Single interface for all AI providers.
// No provider-specific logic may appear outside this module.
export interface AIProvider {
  readonly name: 'gemini' | 'ollama'
  readonly model: string
  generate(prompt: string): Promise<AIResponse>
}

export function createProvider(): AIProvider {
  const name = process.env.AI_PROVIDER ?? 'gemini'
  switch (name) {
    case 'gemini':
      return new GeminiProvider()
    case 'ollama':
      return new OllamaProvider()
    default:
      throw new Error(`Unknown AI_PROVIDER: "${name}". Expected: gemini | ollama`)
  }
}
