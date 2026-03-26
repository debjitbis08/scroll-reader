import { defineMiddleware } from 'astro:middleware'
import { createSupabaseServer } from './lib/supabase.ts'
import { startCronTimer } from './lib/machine.ts'
import { processCron } from './lib/pipeline.ts'

// Start the in-process cron timer (runs once at module load)
startCronTimer(processCron)

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createSupabaseServer(context.request, context.cookies)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  context.locals.user = user
  return next()
})
