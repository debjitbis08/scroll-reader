/**
 * Seed gutenberg_featured with top books per category from Gutendex.
 *
 * Usage: npx tsx scripts/seed-featured.ts
 *
 * Fetches the top 10 books per category ranked by download count.
 * Gutendex is slow (~30-90s per request), so this takes a few minutes.
 * Run it once, or periodically to refresh.
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL required')

const CATEGORIES = [
  'philosophy', 'science', 'history', 'psychology',
  'economics', 'mathematics', 'fiction', 'poetry', 'drama',
]

const PER_CATEGORY = 10

interface GutendexBook {
  id: number
  title: string
  authors: { name: string }[]
  download_count: number
  formats: Record<string, string>
}

interface GutendexResponse {
  count: number
  results: GutendexBook[]
}

async function fetchCategory(category: string): Promise<GutendexBook[]> {
  // Trailing slash avoids a 301 redirect
  const url = `https://gutendex.com/books/?topic=${encodeURIComponent(category)}&languages=en&sort=popular&page=1`
  console.log(`  Fetching ${category}...`)

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    console.warn(`  Failed for ${category}: ${res.status}`)
    return []
  }

  const data = await res.json() as GutendexResponse
  // Gutendex default sort is popular, take top N
  return data.results.slice(0, PER_CATEGORY)
}

async function seed() {
  const client = postgres(DATABASE_URL!)
  const db = drizzle(client)

  console.log(`Fetching top ${PER_CATEGORY} books for ${CATEGORIES.length} categories from Gutendex...`)
  console.log('This will take a few minutes (Gutendex is slow).\n')

  const allRows: { category: string; gutenbergId: number; title: string; author: string | null; rank: number; downloadCount: number }[] = []

  // Fetch sequentially to be nice to Gutendex
  for (const category of CATEGORIES) {
    try {
      const books = await fetchCategory(category)
      for (let i = 0; i < books.length; i++) {
        const b = books[i]
        allRows.push({
          category,
          gutenbergId: b.id,
          title: b.title,
          author: b.authors.map((a) => a.name).join(', ') || null,
          rank: i,
          downloadCount: b.download_count,
        })
      }
      console.log(`  ${category}: ${books.length} books`)
    } catch (err) {
      console.warn(`  ${category}: failed -`, err instanceof Error ? err.message : err)
    }
  }

  if (allRows.length === 0) {
    console.error('No books fetched. Aborting.')
    await client.end()
    process.exit(1)
  }

  // Truncate and re-insert
  await db.execute(sql`TRUNCATE TABLE gutenberg_featured`)

  const BATCH = 100
  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH)
    const values = batch.map((r) =>
      sql`(gen_random_uuid(), ${r.category}, ${r.gutenbergId}, ${r.title}, ${r.author}, ${r.rank}, ${r.downloadCount})`
    )
    await db.execute(sql`
      INSERT INTO gutenberg_featured (id, category, gutenberg_id, title, author, rank, download_count)
      VALUES ${sql.join(values, sql`, `)}
    `)
  }

  console.log(`\nDone! Inserted ${allRows.length} featured books across ${CATEGORIES.length} categories.`)
  await client.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
