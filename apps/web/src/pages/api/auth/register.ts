import type { APIRoute } from 'astro'
import { CF_TURNSTILE_SECRET_KEY } from 'astro:env/server'
import { createSupabaseServer } from '../../../lib/supabase.ts'
import { db } from '../../../lib/db.ts'
import { profiles } from '@scroll-reader/db'

async function validateTurnstile(token: string, remoteIp?: string): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: CF_TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
      }),
    })
    const { success } = await res.json()
    return !!success
  } catch {
    return false
  }
}

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  const form = await request.formData()
  const email = form.get('email')?.toString() ?? ''
  const password = form.get('password')?.toString() ?? ''
  const displayName = form.get('display_name')?.toString()?.trim() || null
  const turnstileToken = form.get('cf-turnstile-response')?.toString() ?? ''

  if (!email || !password) return redirect('/register?error=missing_fields')

  if (!turnstileToken || !(await validateTurnstile(turnstileToken, clientAddress))) {
    return redirect('/register?error=captcha_failed')
  }

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
