import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Self-hosted auth tables — not used with Supabase Auth.
// RLS enabled; no policies = locked down by default.

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique().notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // hex token
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})
