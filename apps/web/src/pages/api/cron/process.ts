import type { APIRoute } from 'astro'
import { processCron } from '../../../lib/pipeline.ts'
import { runCronGuarded } from '../../../lib/machine.ts'
import { CRON_SECRET } from 'astro:env/server'

/**
 * Manual cron trigger — for debugging or forcing a run.
 *
 * Requires: Authorization: Bearer <CRON_SECRET>
 * Shares the same concurrency guard as the in-process timer.
 */
export const POST: APIRoute = async ({ request }) => {
  const auth = request.headers.get('Authorization')
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const ran = await runCronGuarded(processCron)

  if (!ran) {
    return new Response('OK (already running, skipped)', { status: 200 })
  }

  return new Response('OK', { status: 200 })
}
