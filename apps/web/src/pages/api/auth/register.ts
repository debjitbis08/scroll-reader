import type { APIRoute } from 'astro'
import { createSupabaseServer } from '../../../lib/supabase.ts'
import { db } from '../../../lib/db.ts'
import { profiles } from '@scroll-reader/db'

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  const form = await request.formData()
  const email = form.get('email')?.toString() ?? ''
  const password = form.get('password')?.toString() ?? ''
  const displayName = form.get('display_name')?.toString()?.trim() || null

  if (!email || !password) return redirect('/register?error=missing_fields')

  const supabase = createSupabaseServer(request, cookies)
  const {
    data: { user },
    error,
  } = await supabase.auth.signUp({ email, password })

  if (error) return redirect(`/register?error=${encodeURIComponent(error.message)}`)
  if (!user) return redirect('/register?error=signup_failed')

  // Create profile row — profiles.id mirrors auth.users.id
  await db.insert(profiles).values({ id: user.id, displayName }).onConflictDoNothing()

  // If email confirmation is enabled the user isn't logged in yet; redirect to a notice page.
  // If disabled (recommended for dev), they're fully signed in.
  return redirect('/')
}
