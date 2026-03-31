import type { APIRoute } from 'astro'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../../../lib/db.ts'
import { documents, chunks, cards, usageEvents } from '@scroll-reader/db'
import { processDocument } from '../../../lib/pipeline.ts'
import { createSupabaseServer } from '../../../lib/supabase.ts'
import { ADMIN_EMAILS } from 'astro:env/server'

const adminEmails = new Set(
  ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
)

function isAdmin(email: string | undefined): boolean {
  return !!email && adminEmails.has(email.toLowerCase())
}

/**
 * Admin-only: generate cards for a specific document, bypassing daily limits.
 *
 * POST { documentId: string, count: number }
 */
export const POST: APIRoute = async ({ request, cookies }) => {
  const supabase = createSupabaseServer(request, cookies)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user.email)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body.documentId !== 'string' || typeof body.count !== 'number') {
    return new Response(JSON.stringify({ error: 'Invalid body — need { documentId, count }' }), { status: 400 })
  }

  const count = Math.min(Math.max(1, Math.floor(body.count)), 100)

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, body.documentId))
    .limit(1)

  if (!doc) {
    return new Response(JSON.stringify({ error: 'Document not found' }), { status: 404 })
  }

  const validStatuses = ['chunking', 'generating']
  if (!validStatuses.includes(doc.processingStatus ?? '')) {
    return new Response(JSON.stringify({
      error: `Document status is "${doc.processingStatus}" — must be "chunking" or "generating"`,
    }), { status: 409 })
  }

  try {
    const generated = await processDocument(doc, count)

    // Log usage event for auditing (still counts toward the user's daily total,
    // but admin bypasses the check so it doesn't block anything).
    if (generated > 0) {
      await db.insert(usageEvents).values({
        userId: doc.userId,
        eventType: 'cards_generated',
        quantity: generated,
        documentId: doc.id,
      }).catch(() => {})
    }

    // Fetch updated counts
    const [cardRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(cards)
      .innerJoin(chunks, eq(cards.chunkId, chunks.id))
      .where(and(eq(cards.userId, doc.userId), eq(chunks.documentId, doc.id)))

    const [freshDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, doc.id))
      .limit(1)

    return new Response(JSON.stringify({
      generated,
      totalCards: cardRow?.count ?? 0,
      chunkCount: freshDoc?.chunkCount ?? 0,
      processingStatus: freshDoc?.processingStatus,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[admin/generate] error:', err)
    return new Response(JSON.stringify({
      error: err instanceof Error ? err.message : 'Unknown error',
    }), { status: 500 })
  }
}
