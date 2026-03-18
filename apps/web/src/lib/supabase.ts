import { createServerClient, parseCookieHeader, type CookieOptions } from '@supabase/ssr'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from 'astro:env/server'
import type { AstroCookies } from 'astro'

/**
 * Creates a server-side Supabase client that reads/writes cookies via Astro's
 * cookie API. Use in middleware and API routes.
 */
export function createSupabaseServer(request: Request, cookies: AstroCookies) {
  return createServerClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return parseCookieHeader(request.headers.get('Cookie') ?? '')
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookies.set(name, value, options as Parameters<AstroCookies['set']>[2])
          })
        },
      },
    },
  )
}
