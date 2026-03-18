import type { APIRoute } from 'astro'
import { createSupabaseServer } from '../../../lib/supabase.ts'

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData()
  const email = form.get('email')?.toString() ?? ''
  const password = form.get('password')?.toString() ?? ''

  if (!email || !password) {
    return redirect('/login?error=missing_fields')
  }

  const supabase = createSupabaseServer(request, cookies)
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return redirect(`/login?error=${encodeURIComponent(error.message)}`)
  }

  return redirect('/')
}
