import type { APIRoute } from 'astro'
import { processCron } from '../../../lib/pipeline.ts'

/**
 * Cron endpoint — run every few hours to distribute load.
 *
 * 1. Chunks documents in 'chunking' state (full extraction)
 * 2. Generates cards per user up to their tier's daily limit
 *
 * Call via: curl -X POST http://localhost:4321/api/cron/process
 * Or set up an external cron service to hit this every 2-4 hours.
 */
export const POST: APIRoute = async () => {
  try {
    await processCron()
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[cron] processCron failed:', err)
    return new Response('Internal error', { status: 500 })
  }
}
