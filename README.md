# 📜 Scroll Reader

You're going to scroll anyway. Might as well scroll your books.

Scroll Reader turns your personal library into a doom-scroll feed. Upload an EPUB or PDF. An AI reads it and generates a feed of notes, questions, flashcards, definitions, and connections. The feed adapts to how you engage, spacing cards you need to revisit and retiring the ones that stuck.

Built for people who have more books than time, and more time on their phones than they'd like.

## Monorepo Structure

```
apps/
  web/          Astro 5 web app (SSR, SolidJS islands, Supabase Auth)
  worker/       Node.js worker (extract → chunk → AI → DB)
packages/
  chunker/      Rust crate — paragraph-aware text chunker
  extractor/    Rust crate — EPUB + PDF → structured elements
  db/           Drizzle ORM schema + migrations
  shared-types/ Shared TypeScript types
tools/
  card-tester/  Card generation testing utility
```

## Architecture

Document extraction and chunking are written in Rust (`packages/extractor`, `packages/chunker`). The same binaries run in the hosted worker and will be embedded directly in the Tauri desktop app, keeping parsing behaviour identical across both deployment targets.

The web layer stays thin: Astro for SSR, SolidJS for reactive islands, Supabase for auth and storage. The worker is a separate Node.js process that pulls from a processing queue, so document ingestion never blocks the web server.

The database layer is fully decoupled via Drizzle ORM and a direct `DATABASE_URL` connection, no Supabase client for DB queries. Any PostgreSQL instance works today. Auth is the one remaining Supabase dependency; a drop-in replacement is planned and documented in [`SELF_HOSTING.md`](./SELF_HOSTING.md).

## Prerequisites

- Node.js >= 22
- pnpm >= 9
- Rust >= 1.88
- PostgreSQL database — any provider works. For local or self-hosted deployments, the included Docker Compose file handles this automatically.
- AI provider: Gemini API key (or Ollama for fully local inference)

## Setup

```bash
pnpm install

# Build Rust binaries
cd packages/chunker && cargo build && cd ../..
cd packages/extractor && cargo build && cd ../..

# Configure environment
cp .env.example .env
# Fill in your Supabase, AI, and Turnstile keys

# Generate and run database migrations
pnpm --filter @scroll-reader/db generate
pnpm --filter @scroll-reader/db migrate

# Start dev server
pnpm dev
```

## Deploy (Fly.io)

Set runtime secrets on Fly.io first:

```bash
flyctl secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  GEMINI_API_KEY=... DATABASE_URL=... CF_TURNSTILE_SECRET_KEY=... CRON_SECRET=...
```

Then deploy (passes `CF_TURNSTILE_SITE_KEY` as a build arg since Astro inlines it at build time):

```fish
~/.fly/bin/flyctl deploy --config fly.toml --remote-only --build-arg CF_TURNSTILE_SITE_KEY=(grep CF_TURNSTILE_SITE_KEY .env | cut -d= -f2)
```

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Web framework | Astro 5 (Node.js adapter) | SSR with minimal JS overhead |
| UI reactivity | SolidJS islands | Fine-grained reactivity without React's weight |
| CSS | Tailwind CSS v4 | ¯\\(ツ)/¯ |
| Auth | Supabase Auth (email/password) | Hosted service only; swappable for self-hosted |
| ORM | Drizzle ORM | Type-safe queries, direct `DATABASE_URL`, no vendor lock-in |
| Document parsing | Rust (epub, lopdf, scraper) | Shared binary across hosted worker and Tauri desktop app |
| AI provider | Gemini 2.5 Flash / Pro | Flash for card generation, Pro for cross-document connections |
| Desktop (planned) | Tauri + SolidJS | Local processing, zero document upload |

## Self-Hosting

> [!WARNING]
> Work In Progress.

A single `docker compose up` brings up the web app, worker, and database. No Supabase account required — any PostgreSQL instance works. See [`SELF_HOSTING.md`](./SELF_HOSTING.md) for the full guide, including the auth swap.

## License

AGPL-3.0
