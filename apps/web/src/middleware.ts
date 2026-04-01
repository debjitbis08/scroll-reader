import { defineMiddleware } from 'astro:middleware'
import { createSupabaseServer } from './lib/supabase.ts'
import { startCronTimer } from './lib/machine.ts'
import { processCron } from './lib/pipeline.ts'
import { DISABLE_CRON } from 'astro:env/server'

// Start the in-process cron timer (runs once at module load)
if (!DISABLE_CRON) {
  startCronTimer(processCron)
} else {
  console.log('[cron] disabled via DISABLE_CRON=true')
}

export const onRequest = defineMiddleware(async (context, next) => {
  // Skip auth for prerendered pages (request.headers is unavailable)
  if (context.isPrerendered) {
    return next()
  }

  const supabase = createSupabaseServer(context.request, context.cookies)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  context.locals.user = user
  return next()
})
