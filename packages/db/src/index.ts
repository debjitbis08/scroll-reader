// Auth — self-hosted only. Hosted uses Supabase Auth instead.
export { users, sessions } from './schema/auth.ts'

// Content — shared across both deployment modes
export {
  aiProviderEnum,
  documentTypeEnum,
  processingStatusEnum,
  documentSourceEnum,
  cardTypeEnum,
  chunkTypeEnum,
  feedEventTypeEnum,
  profiles,
  documents,
  chunks,
  cards,
  cardActionEnum,
  cardActions,
  feedEvents,
  jobStatusEnum,
  jobs,
} from './schema/content.ts'

// Inferred row types — use these in apps instead of writing the types by hand
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'
import type { users, sessions } from './schema/auth.ts'
import type { profiles, documents, chunks, cards, cardActions, feedEvents, jobs } from './schema/content.ts'

// Self-hosted auth types
export type User = InferSelectModel<typeof users>
export type Session = InferSelectModel<typeof sessions>

// Shared content types
// Profile is the stable identity type — the userId on all content rows
export type Profile = InferSelectModel<typeof profiles>
export type Document = InferSelectModel<typeof documents>
export type Chunk = InferSelectModel<typeof chunks>
export type Card = InferSelectModel<typeof cards>
export type CardAction = InferSelectModel<typeof cardActions>
export type FeedEvent = InferSelectModel<typeof feedEvents>
export type Job = InferSelectModel<typeof jobs>

export type InsertDocument = InferInsertModel<typeof documents>
export type InsertChunk = InferInsertModel<typeof chunks>
export type InsertCard = InferInsertModel<typeof cards>
export type InsertJob = InferInsertModel<typeof jobs>
