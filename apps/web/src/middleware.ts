import { defineMiddleware } from 'astro:middleware'
import { createSupabaseServer } from './lib/supabase.ts'

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createSupabaseServer(context.request, context.cookies)
  const {
    data: { user },
  } = await supabase.auth.getUser()
  context.locals.user = user
  return next()
})
