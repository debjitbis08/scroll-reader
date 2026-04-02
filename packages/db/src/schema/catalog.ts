import { pgTable, pgPolicy, text, integer, timestamp, uuid, jsonb, index, uniqueIndex, customType } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { authenticatedRole } from 'drizzle-orm/supabase'
import { processingStatusEnum, chunkTypeEnum, cardTypeEnum } from './content.ts'

// Custom type for Postgres tsvector columns
const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector' },
})

// ── Gutenberg catalog — local mirror for search ────────────────────────
// Imported from Gutenberg's weekly CSV dump. ~70k rows, no RLS.

export const gutenbergCatalog = pgTable('gutenberg_catalog', {
  gutenbergId: integer('gutenberg_id').primaryKey(),
  title: text('title').notNull(),
  author: text('author'),
  subjects: text('subjects'), // semicolon-separated from CSV
  bookshelves: text('bookshelves'),
  language: text('language').default('en'),
  issuedAt: text('issued_at'), // date string from CSV
  searchVector: tsvector('search_vector'),
}, (t) => [
  index('idx_gutenberg_search').using('gin', t.searchVector),
  pgPolicy('gutenberg_catalog_select', {
    for: 'select',
    to: authenticatedRole,
    using: sql`true`,
  }),
]).enableRLS()

// ── Featured books per category — seeded from Gutendex by popularity ──

export const gutenbergFeatured = pgTable('gutenberg_featured', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(), // e.g. 'philosophy', 'fiction'
  gutenbergId: integer('gutenberg_id').notNull(),
  title: text('title').notNull(),
  author: text('author'),
  rank: integer('rank').notNull(), // position within category (0 = most popular)
  downloadCount: integer('download_count'),
}, (t) => [
  index('idx_gutenberg_featured_category').on(t.category, t.rank),
  pgPolicy('gutenberg_featured_select', {
    for: 'select',
    to: authenticatedRole,
    using: sql`true`,
  }),
]).enableRLS()

// ── Catalog tables ─────────────────────────────────────────────────────
// Shared cache of pre-processed public-domain books from Project Gutenberg.
// No userId, no RLS — these are shared infrastructure.

export const catalogBooks = pgTable('catalog_books', {
  id: uuid('id').primaryKey().defaultRandom(),
  gutenbergId: integer('gutenberg_id').unique().notNull(),
  title: text('title').notNull(),
  author: text('author'),
  subjects: jsonb('subjects').$type<string[]>(),
  languages: jsonb('languages').$type<string[]>(),
  coverImageUrl: text('cover_image_url'),
  totalPages: integer('total_pages'),
  totalChunks: integer('total_chunks').default(0),
  totalCards: integer('total_cards').default(0),
  toc: jsonb('toc').$type<{ title: string; page: number; level: number; fragment?: string }[] | null>(),
  tocClassification: jsonb('toc_classification').$type<('front' | 'main' | 'back')[] | null>(),
  processingStatus: processingStatusEnum('processing_status').default('pending'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  pgPolicy('catalog_books_select', {
    for: 'select',
    to: authenticatedRole,
    using: sql`true`,
  }),
]).enableRLS()

export const catalogChunks = pgTable('catalog_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogBookId: uuid('catalog_book_id')
    .references(() => catalogBooks.id, { onDelete: 'cascade' })
    .notNull(),
  chunkType: chunkTypeEnum('chunk_type').default('text').notNull(),
  content: text('content').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  chapter: text('chapter'),
  wordCount: integer('word_count'),
  language: text('language').default('en'),
}, (t) => [
  index('idx_catalog_chunks_book').on(t.catalogBookId),
  pgPolicy('catalog_chunks_select', {
    for: 'select',
    to: authenticatedRole,
    using: sql`true`,
  }),
]).enableRLS()

export const catalogCards = pgTable('catalog_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogChunkId: uuid('catalog_chunk_id')
    .references(() => catalogChunks.id, { onDelete: 'cascade' })
    .notNull(),
  cardType: cardTypeEnum('card_type').notNull(),
  content: jsonb('content').notNull(),
  secondaryCatalogChunkId: uuid('secondary_catalog_chunk_id')
    .references(() => catalogChunks.id, { onDelete: 'set null' }),
  aiProvider: text('ai_provider'),
  aiModel: text('ai_model'),
}, (t) => [
  uniqueIndex('idx_catalog_cards_chunk_type').on(t.catalogChunkId, t.cardType),
  pgPolicy('catalog_cards_select', {
    for: 'select',
    to: authenticatedRole,
    using: sql`true`,
  }),
]).enableRLS()
