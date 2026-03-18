import { GeminiProvider } from './gemini.ts'
import { OllamaProvider } from './ollama.ts'
import { AI_PROVIDER } from 'astro:env/server'

// Single interface for all AI providers.
// No provider-specific logic may appear outside this module.
export interface AIProvider {
  readonly name: 'gemini' | 'ollama'
  readonly model: string
  generate(prompt: string): Promise<string>
}

export function createProvider(): AIProvider {
  const name = AI_PROVIDER
  switch (name) {
    case 'gemini':
      return new GeminiProvider()
    case 'ollama':
      return new OllamaProvider()
    default:
      throw new Error(`Unknown AI_PROVIDER: "${name}". Expected: gemini | ollama`)
  }
}
