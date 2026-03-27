import { pgTable, pgEnum, pgPolicy, text, boolean, integer, real, timestamp, uuid, unique, jsonb, index, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { authUid, authenticatedRole } from 'drizzle-orm/supabase'

export const aiProviderEnum = pgEnum('ai_provider_enum', ['gemini', 'ollama'])

export const documentTypeEnum = pgEnum('document_type', [
  'book', 'paper', 'article', 'manual', 'note', 'scripture', 'other', 'fiction',
])

export const readingGoalEnum = pgEnum('reading_goal', ['casual', 'reflective', 'study'])

export const processingStatusEnum = pgEnum('processing_status', [
  'pending', 'preview', 'chunking', 'generating', 'ready', 'error',
])

export const documentSourceEnum = pgEnum('document_source', [
  'desktop', 'upload', 'server',
])

export const cardTypeEnum = pgEnum('card_type', [
  'discover', 'connect', 'raw_commentary', 'flashcard', 'quiz', 'glossary', 'contrast', 'passage',
])

export const chunkTypeEnum = pgEnum('chunk_type', ['text', 'image', 'code'])

export const tierEnum = pgEnum('tier', ['free', 'plus'])

export const feedEventTypeEnum = pgEnum('feed_event_type', [
  'scrolled_past', 'glanced', 'engaged',
])

// The stable identity anchor used across both deployment modes:
//   - Self-hosted: profiles.id = users.id (our custom auth)
//   - Hosted:      profiles.id = auth.users.id (Supabase Auth, set via trigger)
// All content tables reference profiles.id — never users.id directly.
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // no FK here — target differs by deployment mode
  displayName: text('display_name'),
  aiProvider: aiProviderEnum('ai_provider').default('gemini'),
  aiKeyHint: text('ai_key_hint'), // last 4 chars, display only
  aiModel: text('ai_model'),
  ollamaBaseUrl: text('ollama_base_url'),
  tier: tierEnum('tier').default('free').notNull(),
  virtualTime: real('virtual_time').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title').notNull(),
  author: text('author'),
  documentType: documentTypeEnum('document_type').default('other').notNull(),
  language: text('language').default('en'),
  isRead: boolean('is_read').default(false),
  source: documentSourceEnum('source').notNull(),
  filePath: text('file_path'),
  fileSize: integer('file_size'), // bytes
  processingStatus: processingStatusEnum('processing_status').default('pending'),
  totalPages: integer('total_pages'),
  pageStart: integer('page_start'),
  pageEnd: integer('page_end'),
  totalElements: integer('total_elements'), // total extracted elements (set after first extraction)
  elementsProcessed: integer('elements_processed').default(0), // how many elements have been chunked so far
  chunkCount: integer('chunk_count').default(0),
  cardCount: integer('card_count').default(0),
  readingGoal: readingGoalEnum('reading_goal'),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  docVirtualTime: real('doc_virtual_time').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
  // 'text'  — regular text passage produced by the chunker
  // 'image' — an image encountered during extraction; content = alt text (may be empty)
  //           image chunks never generate cards directly but appear as context for adjacent text chunks
  // 'code'  — a code block (<pre>/<code>) extracted with preserved whitespace
  //           language field stores the programming language hint (e.g. "python", "rust")
  chunkType: chunkTypeEnum('chunk_type').default('text').notNull(),
  content: text('content').notNull(), // alt text for image chunks, passage text for text chunks
  encrypted: boolean('encrypted').notNull().default(false),
  // Sequential index across both text AND image chunks in document order.
  // Assigned by the extraction layer, not the chunker binary.
  chunkIndex: integer('chunk_index').notNull(),
  chapter: text('chapter'),
  wordCount: integer('word_count'), // 0 for image chunks
  language: text('language').default('en'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const chunkImages = pgTable('chunk_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  chunkId: uuid('chunk_id')
    .references(() => chunks.id, { onDelete: 'cascade' })
    .notNull(),
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type').notNull(),
  altText: text('alt_text').default('').notNull(),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_chunk_images_chunk_id').on(t.chunkId),
  pgPolicy('chunk_images_select_own', {
    for: 'select',
    to: authenticatedRole,
    using: sql`EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.id} = ${t.chunkId} AND ${chunks.userId} = ${authUid})`,
  }),
  pgPolicy('chunk_images_insert_own', {
    for: 'insert',
    to: authenticatedRole,
    withCheck: sql`EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.id} = ${t.chunkId} AND ${chunks.userId} = ${authUid})`,
  }),
  pgPolicy('chunk_images_update_own', {
    for: 'update',
    to: authenticatedRole,
    using: sql`EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.id} = ${t.chunkId} AND ${chunks.userId} = ${authUid})`,
  }),
  pgPolicy('chunk_images_delete_own', {
    for: 'delete',
    to: authenticatedRole,
    using: sql`EXISTS (SELECT 1 FROM ${chunks} WHERE ${chunks.id} = ${t.chunkId} AND ${chunks.userId} = ${authUid})`,
  }),
]).enableRLS()

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'cascade' }),
  cardType: cardTypeEnum('card_type').notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  encrypted: boolean('encrypted').notNull().default(false),
  secondaryChunkId: uuid('secondary_chunk_id').references(() => chunks.id),
  aiProvider: text('ai_provider'),
  aiModel: text('ai_model'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const jobStatusEnum = pgEnum('job_status', ['queued', 'processing', 'done', 'failed'])

// Background processing job — one row per uploaded document.
// The web server fires the pipeline async and updates this row as it progresses.
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  documentId: uuid('document_id')
    .references(() => documents.id, { onDelete: 'cascade' })
    .notNull(),
  status: jobStatusEnum('status').default('queued').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const cardActionEnum = pgEnum('card_action', ['like', 'dismiss', 'bookmark'])

export const cardActions = pgTable('card_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  cardId: uuid('card_id')
    .references(() => cards.id, { onDelete: 'cascade' })
    .notNull(),
  action: cardActionEnum('action').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  unique().on(t.userId, t.cardId, t.action),
])

export const feedEvents = pgTable('feed_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  cardId: uuid('card_id').references(() => cards.id),
  eventType: feedEventTypeEnum('event_type').notNull(),
  dwellMs: integer('dwell_ms'),
  timeOfDay: integer('time_of_day'),
  dayOfWeek: integer('day_of_week'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  index('idx_feed_events_user_created').on(t.userId, t.createdAt),
])

export const cardScores = pgTable('card_scores', {
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  cardId: uuid('card_id')
    .references(() => cards.id, { onDelete: 'cascade' })
    .notNull(),
  timesShown: integer('times_shown').notNull().default(0),
  timesEngaged: integer('times_engaged').notNull().default(0),
  timesSkipped: integer('times_skipped').notNull().default(0),
  lastShownAt: timestamp('last_shown_at', { withTimezone: true }),
  srRepetition: integer('sr_repetition').notNull().default(0),
  srIntervalDays: real('sr_interval_days').default(1),
  srDueAt: timestamp('sr_due_at', { withTimezone: true }),
  srEaseFactor: real('sr_ease_factor').default(2.5),
}, (t) => [
  primaryKey({ columns: [t.userId, t.cardId] }),
  pgPolicy('card_scores_select_own', {
    for: 'select',
    to: authenticatedRole,
    using: sql`${t.userId} = ${authUid}`,
  }),
  pgPolicy('card_scores_insert_own', {
    for: 'insert',
    to: authenticatedRole,
    withCheck: sql`${t.userId} = ${authUid}`,
  }),
  pgPolicy('card_scores_update_own', {
    for: 'update',
    to: authenticatedRole,
    using: sql`${t.userId} = ${authUid}`,
  }),
  pgPolicy('card_scores_delete_own', {
    for: 'delete',
    to: authenticatedRole,
    using: sql`${t.userId} = ${authUid}`,
  }),
]).enableRLS()
