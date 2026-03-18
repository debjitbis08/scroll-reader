import type { APIRoute } from 'astro'
import { processDaily } from '../../../lib/pipeline.ts'

/**
 * Daily cron endpoint — processes the next batch of chunks for all
 * documents still in 'generating' state.
 *
 * Call via: curl -X POST http://localhost:4321/api/cron/process
 * Or set up a system cron / external cron service to hit this daily.
 */
export const POST: APIRoute = async () => {
  try {
    await processDaily()
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[cron] processDaily failed:', err)
    return new Response('Internal error', { status: 500 })
  }
}
