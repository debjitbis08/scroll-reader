#!/usr/bin/env tsx
/**
 * Local HTTP server for the test feed viewer.
 *
 * Serves the Vite-built SolidJS frontend from dist-client/ and
 * provides /api/cards, /api/chunks, and /images/* endpoints.
 *
 * Usage:
 *   pnpm --filter card-tester serve [-- --dir ./test-output --port 3333]
 */

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(HERE, 'dist-client')

const args = process.argv.slice(2).filter(a => a !== '--')
const { values } = parseArgs({
  args,
  options: {
    dir: { type: 'string', default: join(HERE, 'test-output') },
    port: { type: 'string', default: '3333' },
  },
})

const outDir = resolve(values.dir!)
const port = parseInt(values.port!, 10)

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

async function serveStatic(filePath: string, res: import('node:http').ServerResponse): Promise<boolean> {
  try {
    const s = await stat(filePath)
    if (!s.isFile()) return false
    const data = await readFile(filePath)
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    res.end(data)
    return true
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  const path = url.pathname

  try {
    // API endpoints
    if (path === '/api/cards') {
      const data = await readFile(join(outDir, 'cards.json'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(data)
      return
    }

    if (path === '/api/chunks') {
      const data = await readFile(join(outDir, 'chunks.json'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(data)
      return
    }

    // Test output images
    if (path.startsWith('/images/')) {
      const filePath = join(outDir, path)
      if (await serveStatic(filePath, res)) return
    }

    // Static files from Vite build
    if (path !== '/' && await serveStatic(join(DIST_DIR, path), res)) return

    // SPA fallback — serve index.html
    const indexPath = join(DIST_DIR, 'index.html')
    const html = await readFile(indexPath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `File not found. Run "pnpm build:client" first, then "extract" and "generate".`
      : (err as Error).message
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(message)
  }
})

server.listen(port, () => {
  console.log(`Test feed server running at http://localhost:${port}`)
  console.log(`Serving data from ${outDir}`)
})
