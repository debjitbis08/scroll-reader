import { pgTable, pgEnum, text, integer, real, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core'
import { profiles } from './content.ts'
import { documents } from './content.ts'
import { chunks } from './content.ts'
import { aiProviderEnum } from './content.ts'

export const aiOperationEnum = pgEnum('ai_operation', ['chunking', 'card_generation'])

export const aiUsageLogs = pgTable('ai_usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  documentId: uuid('document_id')
    .references(() => documents.id, { onDelete: 'set null' }),
  chunkId: uuid('chunk_id')
    .references(() => chunks.id, { onDelete: 'set null' }),
  operation: aiOperationEnum('operation').notNull(),
  provider: aiProviderEnum('provider').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms'),
  estimatedCostUsd: real('estimated_cost_usd'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  index('idx_ai_usage_user_created').on(t.userId, t.createdAt),
  index('idx_ai_usage_document').on(t.documentId),
])
