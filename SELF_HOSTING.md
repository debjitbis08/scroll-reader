# Self-Hosting Scroll Reader

## Status

| Component | Supabase dependency | Effort to swap |
|-----------|-------------------|----------------|
| Database | None — Drizzle ORM, direct `DATABASE_URL` | Zero. Any Postgres works today. |
| Storage | Supabase Storage | Low — interface already abstracted |
| Auth | Supabase Auth | Moderate |

## Database: Already decoupled
Uses Drizzle ORM with a direct `DATABASE_URL` connection. No Supabase client for DB queries. **Zero work** — any Postgres instance works today.

## Storage: Already decoupled
`storage.ts` already has a `StorageProvider` interface. You'd just write a `LocalFsStorage implements StorageProvider` class and swap the singleton. The rest of the codebase never touches Supabase Storage directly. **~1 file to change.**

## Auth replacement

This is the only tightly coupled part. Supabase auth is used in two patterns:

1. **`supabase.ts`** — creates the SSR client (`@supabase/ssr`)
2. **`middleware.ts`** — calls `supabase.auth.getUser()` to populate `locals.user`
3. **3 auth routes** — `signUp()`, `signInWithPassword()`, `signOut()`
4. **~11 API routes** — all call `supabase.auth.getUser()` for auth checks

But the good news is the API routes don't use Supabase auth directly for anything beyond getting the user ID — they all just read `locals.user` from the middleware, or duplicate the `getUser()` call. If you centralize auth into the middleware (which it already mostly is), the API routes don't need to change at all.

### What you'd need to build for self-hosted auth
- A session/JWT system (e.g. `jose` for JWTs, or plain cookie sessions)
- Password hashing (`argon2`)
- A `users` table in Postgres (replaces Supabase `auth.users`)
- Rewrite `supabase.ts` → generic `auth.ts` that validates sessions
- Rewrite 3 auth routes (login/register/logout)
- Update middleware to use the new auth helper
- Remove `supabase.auth.getUser()` calls from API routes that duplicate the middleware check (they should just use `locals.user`)

### Estimate
- **Storage swap**: trivial, interface already exists
- **Auth swap**: moderate — ~5 files to rewrite, ~11 API routes to clean up (just remove redundant `getUser()` calls and rely on middleware)
- **No schema changes needed** — `profiles` table already exists in Drizzle
