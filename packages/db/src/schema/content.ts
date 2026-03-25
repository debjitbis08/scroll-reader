import { pgTable, pgEnum, text, boolean, integer, timestamp, uuid, unique, jsonb } from 'drizzle-orm/pg-core'

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
  'discover', 'connect', 'raw_commentary', 'sanskrit',
])

export const chunkTypeEnum = pgEnum('chunk_type', ['text', 'image', 'code'])

export const tierEnum = pgEnum('tier', ['free', 'plus'])

export const feedEventTypeEnum = pgEnum('feed_event_type', [
  'view', 'pause', 'skip', 'engage', 'expand',
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
  cardStrategy: jsonb('card_strategy').$type<{ cardTypes: string[]; chunkInterval: number }>(),
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

export const cards = pgTable('cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'cascade' }),
  cardType: cardTypeEnum('card_type').notNull(),
  front: text('front').notNull(),
  back: text('back'),
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
})
