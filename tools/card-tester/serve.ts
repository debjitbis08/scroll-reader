#!/usr/bin/env tsx
/**
 * Local HTTP server for the test feed viewer.
 *
 * Usage:
 *   pnpm --filter card-tester serve [-- --dir ./test-output --port 3333]
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))

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
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)
  const path = url.pathname

  try {
    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(HERE, 'feed.html'), 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
      return
    }

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

    if (path.startsWith('/images/')) {
      const filePath = join(outDir, path)
      const data = await readFile(filePath)
      const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime })
      res.end(data)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  } catch (err) {
    const message = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `File not found. Run "extract" and "generate" first.`
      : (err as Error).message
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(message)
  }
})

server.listen(port, () => {
  console.log(`Test feed server running at http://localhost:${port}`)
  console.log(`Serving data from ${outDir}`)
})
