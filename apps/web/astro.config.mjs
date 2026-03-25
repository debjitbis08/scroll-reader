import { defineConfig, envField } from 'astro/config'
import node from '@astrojs/node'
import solidJs from '@astrojs/solid-js'
import icon from 'astro-icon'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: {
    allowedDomains: [
      { hostname: 'scrollreader.app' },
      { hostname: 'www.scrollreader.app' },
    ],
  },
  integrations: [
    solidJs(),
    icon({
      include: { mdi: ['*'] },
    }),
  ],
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: 'server', access: 'secret' }),
      SUPABASE_ANON_KEY: envField.string({ context: 'server', access: 'secret' }),
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      DATABASE_URL: envField.string({ context: 'server', access: 'secret' }),
      AI_PROVIDER: envField.string({ context: 'server', access: 'secret', default: 'gemini' }),
      GEMINI_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      GEMINI_MODEL: envField.string({ context: 'server', access: 'secret', default: 'gemini-2.5-flash' }),
      OLLAMA_BASE_URL: envField.string({ context: 'server', access: 'secret', default: 'http://localhost:11434' }),
      OLLAMA_MODEL: envField.string({ context: 'server', access: 'secret', default: 'mistral:7b' }),
      BATCH_SIZE: envField.number({ context: 'server', access: 'secret', default: 5 }),
      CHUNKER_BIN: envField.string({ context: 'server', access: 'secret', optional: true }),
      EXTRACTOR_BIN: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
  vite: {
    plugins: [tailwindcss()],
    envDir: '../../',
  },
})
