import { pgTable, pgEnum, pgPolicy, integer, timestamp, uuid, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { authUid, authenticatedRole } from 'drizzle-orm/supabase'
import { profiles } from './content.ts'

export const usageEventTypeEnum = pgEnum('usage_event_type', [
  'cards_generated',
  'document_processed',
  'export',
])

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  eventType: usageEventTypeEnum('event_type').notNull(),
  quantity: integer('quantity'),
  documentId: uuid('document_id'), // intentionally no FK — survives doc deletion
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_usage_events_user_type_time').on(t.userId, t.eventType, t.occurredAt),
  pgPolicy('usage_events_select_own', {
    for: 'select',
    to: authenticatedRole,
    using: sql`${t.userId} = ${authUid}`,
  }),
  pgPolicy('usage_events_insert_own', {
    for: 'insert',
    to: authenticatedRole,
    withCheck: sql`${t.userId} = ${authUid}`,
  }),
]).enableRLS()
