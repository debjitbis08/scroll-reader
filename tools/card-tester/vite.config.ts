import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'client'),
  plugins: [solidPlugin(), tailwindcss()],
  resolve: {
    alias: {
      '@web': resolve(__dirname, '../../apps/web/src'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-client'),
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3333',
      '/images': 'http://localhost:3333',
    },
  },
})
