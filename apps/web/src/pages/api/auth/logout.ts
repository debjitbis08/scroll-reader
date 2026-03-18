import type { APIRoute } from 'astro'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const supabase = createSupabaseServer(request, cookies)
  await supabase.auth.signOut()
  return redirect('/login')
}
