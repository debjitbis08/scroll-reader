# Project Spec: Scroll Reader
*A personal doom scroll feed powered by your own documents*

---

## Vision

A doom scroll interface where all content is drawn from the user's personal document library — books, papers, articles, notes, manuals, anything. An AI provider (Gemini or a local model via Ollama) transforms raw passages into feed cards — questions, reflections, connections, teasers. Two distinct products serve two distinct audiences: a hosted cloud product with a desktop companion for less technical users, and a fully self-hostable open source version for those who want everything on their own infrastructure.

---

## Two Products, One Codebase

### Product 1: Hosted Cloud + Desktop App (Less Technical Users)
- Sign up on the hosted platform
- Download the Tauri desktop app — points at the hosted server by default, configurable for self-hosters
- Desktop app reads documents from a local directory, generates cards locally using Gemini or Ollama, syncs only encrypted cards to the cloud
- Feed accessible on any device via the web app
- E2E encrypted — the server never sees document content
- Web upload mode available for trying the product without the desktop app

### Product 2: Self-Hosted Open Source (Technical Users)
- Deploy the full stack on any VPS using Docker Compose
- No desktop app — documents get onto the server however the user chooses (rsync, Syncthing, Nextcloud, manual upload, watched server directory — their decision)
- No E2E encryption needed — the user owns the server, the threat model is different
- Bring your own AI: Gemini API key or a local Ollama instance running on the same server or network
- Full control, full responsibility
- MIT licensed (or AGPL — see Licensing section)

**One codebase, one repo.** Self-hosting is a deployment target, not a fork. Environment variables control all behaviour differences. The hosted product is that same codebase deployed on Fly.io with managed infrastructure.

---

## AI Provider Abstraction

Both products support multiple AI providers. The provider is an abstraction — all prompts are plain text, the interface is simply "take a prompt, return text." No provider-specific logic bleeds into card generation or chunking code.

### Supported Providers

| Provider | Use Case | Notes |
|----------|----------|-------|
| `gemini` | Hosted cloud, desktop app | Best card quality. User supplies own API key (desktop) or platform key (web upload). |
| `ollama` | Self-hosted, desktop app | Fully local, no external API calls. User runs Ollama separately. |

### Configuration

```
# Gemini
AI_PROVIDER=gemini
GEMINI_API_KEY=xxx
GEMINI_MODEL=gemini-2.0-flash        # default, override for connect cards: gemini-2.0-pro

# Ollama (self-hosted server or desktop local)
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=mistral:7b              # see recommended models below
```

### Recommended Local Models (Ollama)

Card quality degrades with smaller models. Be honest about this in documentation.

| Model | Quality | VRAM Required |
|-------|---------|---------------|
| `llama3.1:8b` | Good | ~6GB |
| `mistral:7b` | Good | ~5GB |
| `llama3.2:3b` | Acceptable | ~3GB |
| `phi3:mini` | Basic | ~2GB |

`llama3.1:8b` or `mistral:7b` is the recommended minimum for decent card quality. Document this clearly — users with weaker hardware will get worse cards, and they should know why.

### Desktop App: Provider Settings
- Settings screen shows toggle: **Gemini** (API key input) or **Local Model** (Ollama URL + model name)
- On startup, if Ollama is selected, perform a connectivity check to `OLLAMA_BASE_URL/api/tags` — surface a clear error if unreachable before the user tries to process documents
- API key stored in OS keychain via Tauri `keyring` plugin, never on disk
- Key hint (last 4 chars) shown in UI for confirmation

---

## Product 1: Hosted Cloud + Desktop App

### Tech Stack

**Desktop App**
- Shell: Tauri (Rust)
- Frontend: SolidJS + Alpine.js
- Local DB: SQLite via Tauri SQL plugin
- Encryption: libsodium (sodiumoxide crate)
- AI: Gemini or Ollama, called from Rust backend — never from JS

**Web App**
- Framework: Astro (Node.js adapter)
- Frontend: SolidJS islands + Alpine.js
- Deployment: Fly.io
- AI: Gemini or Ollama, called server-side only

**Shared Backend**
- Database: Supabase (Postgres)
- Auth: Supabase Auth (email/password, magic link)
- File Storage: Supabase Storage — web upload mode only, raw files deleted post-processing

### Privacy & Encryption Model

**Desktop Mode — Genuine E2E Encryption**

Documents stay on the user's machine. Only AI-generated cards leave the device, encrypted before upload. The server stores only ciphertext.

- On signup, a keypair is derived from the user's password using Argon2id
- Private key stored in OS keychain via Tauri `keyring` plugin
- Public key stored in Supabase (for future multi-device key exchange)
- Cards encrypted on-device with public key, decrypted on-device with private key
- `cards.front`, `cards.back`, `chunks.content` are encrypted
- Metadata (`document_id`, `card_type`, `created_at`, `chunk_index`) is not encrypted
- Implementation: `sodiumoxide` crate (Rust/Tauri), `libsodium-wrappers` (JS/web feed)

**Web Upload Mode — No Encryption, No Privacy Guarantee**

The server receives the raw file, reads it, chunks it, calls the AI provider. Card content stored as plaintext in Supabase. Expected and honest behaviour for server-side processing.

UI must clearly state before every upload (non-dismissable, explicit checkbox required):
- "Your document is processed on our servers"
- "Card content is stored unencrypted in our database"
- "Do not upload sensitive or private documents"
- "Use the desktop app if you want your content to stay private"

Cards from web upload flagged with `encrypted: false` — client never attempts decryption.

### Desktop App Architecture

**Directory Watcher**
- User points app at one or more directories
- Tauri watches for new EPUB/PDF files using `notify` crate
- New files surface in the **Inbox** — never processed automatically
- File hashes stored in local SQLite — duplicates and ignored files never resurface

**Inbox (Whitelist Flow)**

Nothing enters the corpus until the user explicitly approves it. No AI calls are made on unapproved files.

Inbox card shows: title, author (from file metadata), file type, size, detected language, suggested document type, full file path.

User actions per document:
- **Add to Library** — confirm/change document type, processing begins
- **Ignore** — dismissed permanently, hash stored in SQLite
- **Decide Later** — stays in Inbox

**Local Processing Pipeline** (triggered only after approval)
1. Text extracted locally (Rust: `epub` crate for EPUB, `pdf-extract` for PDF)
2. Chunked into passages (200–400 words, paragraph-aware, respects chapter boundaries)
3. Language detected (Devanagari U+0900–U+097F = Sanskrit)
4. Each chunk sent to configured AI provider (Gemini or Ollama) from Rust backend
5. Card generated, encrypted with user's local key
6. Encrypted card synced to Supabase (`encrypted: true`)
7. Local SQLite sync state updated

**Local SQLite Schema**
```sql
create table local_files (
  path text primary key,
  file_hash text not null,
  document_id text,
  inbox_status text not null default 'discovered' check (
    inbox_status in ('discovered', 'approved', 'ignored')
  ),
  detected_title text,
  detected_author text,
  detected_language text,
  suggested_document_type text,
  file_size_bytes integer,
  confirmed_document_type text,
  processing_status text check (
    processing_status in ('pending', 'chunking', 'generating', 'ready', 'error')
  ),
  discovered_at datetime default current_timestamp,
  approved_at datetime,
  processed_at datetime
);

create table local_card_cache (
  card_id text primary key,
  decrypted_front text,
  decrypted_back text,
  cached_at datetime
);
```

---

## Product 2: Self-Hosted Open Source

### Tech Stack
- Web App: Astro (Node.js adapter) — same codebase as hosted product
- Worker: Separate Node.js process for document processing (not coupled to web server)
- Database: Postgres (self-managed or any managed Postgres)
- Auth: Supabase Auth (self-hosted Supabase) or configurable OIDC provider in v2
- Storage: Any S3-compatible storage (MinIO, Cloudflare R2, Backblaze B2, self-hosted Minio)
- AI: Gemini API key or Ollama instance on the same server or local network

### Document Ingestion
Self-hosters decide how documents reach the server. The worker monitors a configured directory (`WATCH_DIR`) and processes any EPUB or PDF it finds. There is no Inbox flow for self-hosted — the assumption is that if a file is in the watched directory, the user put it there deliberately.

### No E2E Encryption
Self-hosters own the server. Encryption to protect content from the operator is unnecessary. Cards and chunks stored as plaintext. This simplifies the codebase significantly for the self-hosted path.

### Docker Compose

A complete `docker-compose.yml` ships with the repo. It wires up:
- Web app container
- Worker container (document processing + card generation)
- Postgres
- MinIO (S3-compatible storage)
- Supabase Auth (or a lightweight alternative like Pocketbase for auth only)

Self-hosters clone the repo, copy `.env.example` to `.env`, fill in their AI provider config, run `docker compose up`. That is the entire setup.

### Licensing
The open source version is released under **AGPL-3.0**. Any modifications must be open sourced under the same license. This prevents commercial free-riding while keeping the community honest. The hosted cloud product is the commercial offering — it runs the same code but with managed infrastructure and the desktop app as a proprietary client.

---

## Shared: Database Schema

Used by both products. Self-hosted deployment omits the `encrypted` column logic (always false) but the schema is identical so the codebase stays unified.

```sql
-- Profiles (extends Supabase Auth users)
create table profiles (
  id uuid primary key references auth.users(id),
  display_name text,
  ai_provider text default 'gemini' check (ai_provider in ('gemini', 'ollama')),
  ai_key_hint text,       -- last 4 chars of API key, for UI display only
  ai_model text,          -- e.g. 'gemini-2.0-flash' or 'mistral:7b'
  ollama_base_url text,   -- user-configured Ollama URL (desktop/self-hosted)
  created_at timestamptz default now()
);

-- Documents
create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  title text not null,
  author text,
  document_type text not null default 'other' check (
    document_type in ('book', 'paper', 'article', 'manual', 'note', 'scripture', 'other')
  ),
  language text default 'en',
  is_read boolean default false,
  source text not null check (source in ('desktop', 'upload', 'server')), -- 'server' for self-hosted watched dir
  file_path text,
  processing_status text default 'pending' check (
    processing_status in ('pending', 'chunking', 'generating', 'ready', 'error')
  ),
  chunk_count integer default 0,
  card_count integer default 0,
  created_at timestamptz default now()
);

-- Chunks
create table chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  document_id uuid references documents(id) on delete cascade,
  content text not null,
  encrypted boolean not null default false,
  chunk_index integer not null,
  chapter text,
  word_count integer,
  language text default 'en',
  created_at timestamptz default now()
);

-- Cards
create table cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  chunk_id uuid references chunks(id) on delete cascade,
  card_type text not null check (
    card_type in ('reflect', 'discover', 'connect', 'raw_commentary', 'sanskrit')
  ),
  front text not null,
  back text,
  encrypted boolean not null default false,
  secondary_chunk_id uuid references chunks(id),
  ai_provider text,       -- which provider generated this card
  ai_model text,          -- which model generated this card
  created_at timestamptz default now()
);

-- Feed events
create table feed_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id) on delete cascade not null,
  card_id uuid references cards(id),
  event_type text not null check (
    event_type in ('view', 'pause', 'skip', 'engage', 'expand')
  ),
  dwell_ms integer,
  time_of_day integer,
  day_of_week integer,
  created_at timestamptz default now()
);

-- RLS (hosted product only — self-hosted can disable RLS if single-user)
alter table documents enable row level security;
alter table chunks enable row level security;
alter table cards enable row level security;
alter table feed_events enable row level security;

create policy "Users access own documents" on documents for all using (auth.uid() = user_id);
create policy "Users access own chunks" on chunks for all using (auth.uid() = user_id);
create policy "Users access own cards" on cards for all using (auth.uid() = user_id);
create policy "Users access own feed events" on feed_events for all using (auth.uid() = user_id);
```

---

## Shared: Card Types & Prompts

### Card Types

| Type | For | Description |
|------|-----|-------------|
| `reflect` | Read documents | Surfaces a passage, asks a personal reflection question |
| `discover` | Unread documents | Teases the most intriguing idea to entice reading |
| `connect` | 2+ documents | Non-obvious connection between passages from different documents |
| `raw_commentary` | Any | Raw passage + AI commentary. No question. Just illumination. |
| `sanskrit` | Sanskrit documents | Devanagari + IAST + grammar or translation challenge |

### Prompts

Use the faster/cheaper model for all types except `connect`. For Gemini: `gemini-2.0-flash` default, `gemini-2.0-pro` for connect. For Ollama: same model throughout, user-configured.

```
REFLECT:
"You are generating a reflection card for a personal reading app.
Document type: {document_type}
Passage from '{title}' by {author}:

{chunk_content}

Generate a single thought-provoking question inviting the reader to reflect
on this idea in relation to their own life, work, or beliefs.
Adapt framing to document type — novels warrant personal/emotional questions,
papers warrant intellectual/critical ones.
Return only the question."

DISCOVER:
"You are generating a discovery card for a personal reading app.
Document type: {document_type}
Passage from '{title}' by {author} (user has not read this):

{chunk_content}

Write 2-3 sentences capturing the most interesting or provocative idea
in this passage to make the reader want to explore the document.
Do not summarize — intrigue. Return only those sentences."

CONNECT:
"You are generating a connection card for a personal reading app.
Passage A ({document_type_a}) from '{title_a}' by {author_a}:
{chunk_a}

Passage B ({document_type_b}) from '{title_b}' by {author_b}:
{chunk_b}

Write 2-3 sentences drawing a meaningful, non-obvious connection between
these two ideas. Cross-domain connections are especially valuable.
Return only those sentences."

RAW + COMMENTARY:
"You are generating a commentary for a personal reading app.
Document type: {document_type}
Passage from '{title}' by {author}:

{chunk_content}

Write a short commentary (3-5 sentences):
- What the author is really arguing or showing here
- Why this idea is significant or surprising
- Any connection to broader ideas, history, or other thinkers
Do not summarize. Illuminate. Return only the commentary."

SANSKRIT:
"You are generating a Sanskrit learning card for a personal reading app.
Sanskrit passage:

{chunk_content}

Generate a card with:
1. Sanskrit text in Devanagari
2. IAST transliteration
3. A challenge for an intermediate learner — one of:
   - Translate this into English
   - Identify the case and number of [specific word]
   - What is the verb root (dhatu) of [specific verb]?
   - Apply the relevant sandhi rule to separate: [combined form]
4. The answer

Return as JSON: { devanagari, iast, challenge, answer }"
```

Store `ai_provider` and `ai_model` on every card — essential for debugging quality differences between providers and for selectively regenerating cards when a better model becomes available.

---

## Shared: Frontend Architecture

### Pages

```
/               → Feed (main doom scroll, requires auth)
/upload         → Web upload mode (hosted only, requires auth)
/library        → Document list
/inbox          → Desktop only: newly discovered documents awaiting approval
/settings       → AI provider config, feed preferences, privacy status
/login          → Auth
```

### Feed (SolidJS island)

- Infinite vertical scroll, batches of 10
- IntersectionObserver: log `view` event when card visible, `pause` when visible > 3s
- Card type badge + document title + author on every card
- Encrypted cards (desktop): decrypt client-side on load, skeleton until ready
- Plaintext cards (web upload, self-hosted): render directly
- Privacy indicator per card: 🔒 encrypted, 🌐 plaintext

**Card anatomy:**
```
┌──────────────────────────────┐
│ [TYPE] 🔒     [Document Title]│
│                              │
│  Card content here.          │
│                              │
│ [Primary Action]      [Skip] │
└──────────────────────────────┘
```

**Raw + Commentary:**
```
┌──────────────────────────────┐
│ [RAW] 🔒      [Document Title]│
│                              │
│  "Raw passage text in a      │
│   readable serif font."      │
│                              │
│  ── Commentary ──            │
│  AI thoughts on the passage. │
│                              │
│ [Noted]               [Skip] │
└──────────────────────────────┘
```

**Sanskrit:**
```
┌──────────────────────────────┐
│ [SANSKRIT] 🔒 [Document Title]│
│                              │
│  देवनागरी text here           │
│  IAST transliteration        │
│                              │
│  Challenge: Translate this   │
│                              │
│ [Show Answer]         [Skip] │
└──────────────────────────────┘
```

### Fonts
- UI: System font stack
- Devanagari: `Noto Serif Devanagari` (Google Fonts)
- Passage text (Raw cards): `Lora` or `Literata`

---

## Shared: Feed API

```
GET /api/feed?limit=10&offset=0&types[]=reflect&types[]=raw_commentary
  → Card stubs (id, card_type, chunk_id, encrypted, created_at)
  → v1: random weighted selection
  → v2: weighted by feed_events time patterns

POST /api/feed/event
  body: { card_id, event_type, dwell_ms }

POST /api/upload                          (hosted only)
  body: multipart file + document_type + privacy_acknowledged=true
  → Rejects if privacy_acknowledged !== true

GET /api/documents/:id/status
  → Processing status via Supabase Realtime (do not poll)
```

---

## Environment Variables

### Hosted Web App (Fly.io)
```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
AI_PROVIDER=gemini
GEMINI_API_KEY=                 # platform key for web upload mode
GEMINI_MODEL=gemini-2.0-flash
```

### Self-Hosted (.env in Docker Compose)
```
DATABASE_URL=
AI_PROVIDER=gemini|ollama
GEMINI_API_KEY=                 # if using Gemini
GEMINI_MODEL=gemini-2.0-flash
OLLAMA_BASE_URL=                # if using Ollama, e.g. http://ollama:11434
OLLAMA_MODEL=mistral:7b
WATCH_DIR=/data/documents       # server directory to watch for new files
STORAGE_ENDPOINT=               # S3-compatible endpoint
STORAGE_BUCKET=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
```

### Desktop App (OS keychain, never env files)
```
AI API key         → OS keychain via Tauri keyring plugin
Ollama URL + model → Stored in local SQLite settings table
Supabase anon key  → Bundled in binary (safe, it's a public key)
Server URL         → Stored in local SQLite settings table (default: hosted URL, overridable)
Encryption keypair → OS keychain via Tauri secure storage
```

---

## Recommended Sanskrit Corpus (Public Domain)

- Kalidasa: Meghaduta, Abhijnanashakuntalam
- Bhagavad Gita (plain text)
- Hitopadesa (simple sentences, good for intermediate learners)
- Ishavasya Upanishad (short, dense)
- Amarakosha (Sanskrit lexicon — good for vocabulary cards)

---

## Distribution (Desktop App)

- Direct distribution from your own website — no app stores, no 30% cut
- Mac: Apple Developer account ($99/yr) for notarization
- Windows: SmartScreen warning without code signing — acceptable for v1
- Linux: AppImage, no signing required
- Tauri built-in updater for auto-updates via GitHub releases

---

## v1 Scope

### Desktop App
- [ ] Tauri + SolidJS project setup
- [ ] Configurable server URL in settings (default: hosted, overridable for self-hosters)
- [ ] Directory picker and file watcher (`notify` crate)
- [ ] Inbox view with approve / ignore / decide-later per document
- [ ] Document type confirmation on approval
- [ ] EPUB + PDF extraction (Rust)
- [ ] Paragraph-aware chunker (standalone Rust crate)
- [ ] AI provider abstraction (Gemini + Ollama)
- [ ] Ollama connectivity check on startup if Ollama selected
- [ ] OS keychain storage for API key
- [ ] Local SQLite with inbox_status + processing_status
- [ ] E2E encryption (libsodium, Argon2id keypair)
- [ ] Supabase card sync
- [ ] Feed UI (SolidJS, infinite scroll, decrypt on load, SolidJS store cache)

### Hosted Web App
- [ ] Astro on Fly.io
- [ ] Supabase auth
- [ ] Feed page (encrypted + plaintext cards)
- [ ] Web upload with non-dismissable privacy notice + checkbox
- [ ] Document library page

### Self-Hosted / Open Source
- [ ] Docker Compose with web app, worker, Postgres, MinIO
- [ ] Worker process: watched directory → chunk → AI → store cards
- [ ] AI provider abstraction (same as desktop: Gemini + Ollama)
- [ ] `.env.example` with all required variables documented
- [ ] README with setup instructions

### Shared
- [ ] Card generation: `reflect`, `discover`, `raw_commentary`
- [ ] `document_type` classification with user confirmation
- [ ] Feed event logging
- [ ] RLS policies (hosted) / optional (self-hosted)

## v2 Scope

- [ ] `connect` card type (cross-document)
- [ ] `sanskrit` card type + Devanagari detection
- [ ] Time-of-day / day-of-week personalization from feed_events
- [ ] Card type weight sliders in settings
- [ ] Card regeneration (re-run prompt with updated model)
- [ ] Mobile-optimised web feed
- [ ] OIDC/external auth provider support (self-hosted)

---

## Notes for Claude Code

- **The AI provider is an abstraction from day one.** No Gemini-specific logic in card generation code. The provider module takes a prompt string and returns a text string. Gemini and Ollama are two implementations behind the same interface.
- **Ollama connectivity check is mandatory** on desktop startup when Ollama is selected. Surface a clear, actionable error before the user tries to process documents and hits a confusing failure deep in the pipeline.
- **The Inbox is the gate to the corpus.** No file is chunked, sent to AI, or synced until `inbox_status = 'approved'`. This protects the user's API quota. Ignored file hashes must persist — ignored files never resurface even if moved.
- **The chunker is the most critical component.** Bad chunking produces bad cards regardless of model quality. Split on paragraph boundaries, never mid-sentence. Target 200–400 words. Respect chapter boundaries. Write in Rust, test extensively on real EPUBs before wiring up any AI call.
- **The chunker is a standalone Rust crate.** One implementation, used by Tauri. Compile to WASM if needed for the web upload pipeline.
- **All AI calls from the desktop app go through Tauri Rust backend.** API key never touches JS.
- **All AI calls from the web app go through server-side routes.** Never the client.
- **`encrypted` is a first-class field on chunks and cards.** Always check before render or decryption. Never attempt to decrypt a plaintext card.
- **Web upload privacy notice requires explicit checkbox** — enforce server-side too, not just client-side.
- **`ai_provider` and `ai_model` stored on every card.** Essential for debugging quality and selective regeneration.
- **Sanskrit renders in `Noto Serif Devanagari`.** Load in both Tauri webview and Astro web app.
- **Supabase Realtime for processing status.** No polling loops.
- **Cache decrypted cards in SolidJS store.** Do not re-decrypt on scroll. Clear on session end.
- **Self-hosted Docker Compose must work with a single `docker compose up`** after filling in `.env`. Test this. Do not make self-hosting require manual steps beyond env configuration.
- **No monetization, no feature gating, no subscription logic.** Build the core experience cleanly.
