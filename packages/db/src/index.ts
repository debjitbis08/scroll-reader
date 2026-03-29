// Auth — self-hosted only. Hosted uses Supabase Auth instead.
export { users, sessions } from './schema/auth.ts'

// Content — shared across both deployment modes
export {
  aiProviderEnum,
  documentTypeEnum,
  processingStatusEnum,
  documentSourceEnum,
  documentPriorityEnum,
  cardTypeEnum,
  chunkTypeEnum,
  readingGoalEnum,
  tierEnum,
  feedEventTypeEnum,
  profiles,
  documents,
  collections,
  collectionDocuments,
  chunks,
  chunkImages,
  cards,
  cardActionEnum,
  cardActions,
  feedEvents,
  cardScores,
  jobStatusEnum,
  jobs,
} from './schema/content.ts'

// AI usage tracking
export { aiOperationEnum, aiUsageLogs } from './schema/ai_usage.ts'

// Usage events — product-level metering (limits, analytics)
export { usageEventTypeEnum, usageEvents } from './schema/usage_events.ts'

// Inferred row types — use these in apps instead of writing the types by hand
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'
import type { users, sessions } from './schema/auth.ts'
import type { profiles, documents, collections, collectionDocuments, chunks, chunkImages, cards, cardActions, feedEvents, cardScores, jobs } from './schema/content.ts'
import type { aiUsageLogs } from './schema/ai_usage.ts'
import type { usageEvents } from './schema/usage_events.ts'

// Self-hosted auth types
export type User = InferSelectModel<typeof users>
export type Session = InferSelectModel<typeof sessions>

// Shared content types
// Profile is the stable identity type — the userId on all content rows
export type Profile = InferSelectModel<typeof profiles>
export type Document = InferSelectModel<typeof documents>
export type Collection = InferSelectModel<typeof collections>
export type CollectionDocument = InferSelectModel<typeof collectionDocuments>
export type Chunk = InferSelectModel<typeof chunks>
export type ChunkImage = InferSelectModel<typeof chunkImages>
export type Card = InferSelectModel<typeof cards>
export type CardAction = InferSelectModel<typeof cardActions>
export type FeedEvent = InferSelectModel<typeof feedEvents>
export type CardScore = InferSelectModel<typeof cardScores>
export type Job = InferSelectModel<typeof jobs>

export type InsertCollection = InferInsertModel<typeof collections>
export type InsertDocument = InferInsertModel<typeof documents>
export type InsertChunk = InferInsertModel<typeof chunks>
export type InsertChunkImage = InferInsertModel<typeof chunkImages>
export type InsertCard = InferInsertModel<typeof cards>
export type InsertJob = InferInsertModel<typeof jobs>

export type AiUsageLog = InferSelectModel<typeof aiUsageLogs>
export type InsertAiUsageLog = InferInsertModel<typeof aiUsageLogs>

export type UsageEvent = InferSelectModel<typeof usageEvents>
export type InsertUsageEvent = InferInsertModel<typeof usageEvents>
