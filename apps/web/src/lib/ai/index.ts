import { GeminiProvider } from './gemini.ts'
import { OllamaProvider } from './ollama.ts'
import { AI_PROVIDER } from 'astro:env/server'

// Re-export AI types from the shared pipeline package
export type { ImagePart, AIUsage, AIResponse, AIProvider } from '@scroll-reader/pipeline'
import type { AIProvider } from '@scroll-reader/pipeline'

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
