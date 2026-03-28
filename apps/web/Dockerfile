# Stage 1: Build Rust binaries (chunker + extractor)
FROM rust:1.88-slim AS rust-builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Build chunker
COPY packages/chunker/ packages/chunker/
RUN cd packages/chunker && cargo build --release

# Build extractor
COPY packages/extractor/ packages/extractor/
RUN cd packages/extractor && cargo build --release

# Stage 2: Build Node.js app
FROM node:22-slim AS node-builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config + lockfile first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/db/ packages/db/
COPY packages/shared-types/ packages/shared-types/
COPY apps/web/ apps/web/

# Astro needs env vars at build time for validation — provide dummy values
# Real values are set as Fly.io secrets at runtime
ENV SUPABASE_URL=https://placeholder.supabase.co
ENV SUPABASE_ANON_KEY=placeholder
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV CRON_SECRET=placeholder

# Client-context env var — inlined at build time, pass via --build-arg
ARG CF_TURNSTILE_SITE_KEY
ENV CF_TURNSTILE_SITE_KEY=$CF_TURNSTILE_SITE_KEY

RUN pnpm --filter @scroll-reader/web build

# Stage 3: Runtime
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y poppler-utils python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages pymupdf
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace config + lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile --prod

# Copy built Astro app
COPY --from=node-builder /app/apps/web/dist apps/web/dist

# Copy shared packages (needed at runtime for imports)
COPY --from=node-builder /app/packages/db packages/db
COPY --from=node-builder /app/packages/shared-types packages/shared-types

# Copy Rust binaries
COPY --from=rust-builder /build/packages/chunker/target/release/chunker /usr/local/bin/chunker
COPY --from=rust-builder /build/packages/extractor/target/release/extractor /usr/local/bin/extractor
COPY packages/extractor/figure_extract.py /usr/local/bin/figure_extract.py

ENV HOST=0.0.0.0
ENV PORT=8080
ENV CHUNKER_BIN=/usr/local/bin/chunker
ENV EXTRACTOR_BIN=/usr/local/bin/extractor
ENV FIGURE_EXTRACT_BIN=/usr/local/bin/figure_extract.py
ENV NODE_OPTIONS="--max-http-header-size=32768"

EXPOSE 8080

CMD ["node", "apps/web/dist/server/entry.mjs"]
