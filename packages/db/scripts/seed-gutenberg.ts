/**
 * Seed the gutenberg_catalog table from Project Gutenberg's CSV catalog.
 *
 * Usage:
 *   # Download first (curl handles Gutenberg's slow server better):
 *   curl -L -o /tmp/pg_catalog.csv.gz https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz
 *   # Then seed:
 *   npx tsx scripts/seed-gutenberg.ts
 *
 * Or provide a custom path:
 *   npx tsx scripts/seed-gutenberg.ts /path/to/pg_catalog.csv.gz
 */

import { createReadStream } from 'node:fs'
import { access, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { parse } from 'csv-parse'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL required')

const DEFAULT_GZ = '/tmp/pg_catalog.csv.gz'
const TMP_CSV = '/tmp/pg_catalog.csv'

interface CsvRow {
  'Text#': string
  Type: string
  Issued: string
  Title: string
  Language: string
  Authors: string
  Subjects: string
  LoCC: string
  Bookshelves: string
}

async function decompress(gzPath: string) {
  await access(gzPath) // throws if file doesn't exist
  console.log(`Decompressing ${gzPath}...`)
  await pipeline(
    createReadStream(gzPath),
    createGunzip(),
    createWriteStream(TMP_CSV),
  )
  console.log('Decompressed.')
}

async function seed() {
  const gzPath = process.argv[2] || DEFAULT_GZ

  try {
    await access(gzPath)
  } catch {
    console.error(`File not found: ${gzPath}`)
    console.error('Download it first:')
    console.error('  curl -L -o /tmp/pg_catalog.csv.gz https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv.gz')
    process.exit(1)
  }

  await decompress(gzPath)

  const client = postgres(DATABASE_URL!)
  const db = drizzle(client)

  // Parse CSV
  const rows: { gutenbergId: number; title: string; author: string | null; subjects: string | null; bookshelves: string | null; language: string; issuedAt: string | null }[] = []

  const parser = createReadStream(TMP_CSV).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }),
  )

  for await (const row of parser as AsyncIterable<CsvRow>) {
    const id = parseInt(row['Text#'], 10)
    if (isNaN(id)) continue
    // Only include Text type (skip Audio, etc.) and English
    if (row.Type !== 'Text') continue
    if (!row.Language?.includes('en')) continue

    rows.push({
      gutenbergId: id,
      title: row.Title?.replace(/\r?\n/g, ' ').trim() || 'Untitled',
      author: row.Authors?.trim() || null,
      subjects: row.Subjects?.trim() || null,
      bookshelves: row.Bookshelves?.trim() || null,
      language: row.Language?.trim() || 'en',
      issuedAt: row.Issued?.trim() || null,
    })
  }

  console.log(`Parsed ${rows.length} English text entries.`)

  // Truncate and re-insert in batches
  await db.execute(sql`TRUNCATE TABLE gutenberg_catalog`)

  const BATCH = 1000
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const values = batch.map((r) =>
      sql`(${r.gutenbergId}, ${r.title}, ${r.author}, ${r.subjects}, ${r.bookshelves}, ${r.language}, ${r.issuedAt},
        to_tsvector('english', coalesce(${r.title}, '') || ' ' || coalesce(${r.author}, '') || ' ' || coalesce(${r.subjects}, '')))`
    )

    await db.execute(sql`
      INSERT INTO gutenberg_catalog (gutenberg_id, title, author, subjects, bookshelves, language, issued_at, search_vector)
      VALUES ${sql.join(values, sql`, `)}
    `)

    if ((i / BATCH) % 10 === 0) {
      console.log(`  Inserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
    }
  }

  console.log(`Done! Inserted ${rows.length} rows.`)

  await unlink(TMP_CSV).catch(() => {})
  await client.end()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
