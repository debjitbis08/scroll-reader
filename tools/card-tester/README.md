# Card Tester

Standalone test harness for the extraction → chunking → card generation pipeline. No database, no web app — just CLI scripts that produce JSON and a local feed viewer.

## Prerequisites

- Rust binaries built in release mode:
  ```bash
  cd packages/extractor && cargo build --release
  cd packages/chunker && cargo build --release
  ```
- Python 3 + PyMuPDF (for vector figure extraction from PDFs):
  ```bash
  pip install pymupdf
  ```
- `GEMINI_API_KEY` set in the root `.env` file (or `OLLAMA_BASE_URL` for Ollama)

## Usage

### Step 1: Extract and chunk

```bash
pnpm --filter card-tester extract -- --file ~/Downloads/book.pdf
```

Options:
- `--file` (required) — path to PDF, EPUB, or TXT file
- `--pages 1-10` — restrict to a page range (PDF only)
- `--out ./test-output` — output directory (default: `./test-output`)

Outputs:
- `test-output/chunks.json` — array of chunks with associated images
- `test-output/images/` — extracted figure images

### Step 2: Generate cards

```bash
pnpm --filter card-tester generate -- --type book --goal study
```

Options:
- `--type` — document type: `book`, `paper`, `article`, `manual`, `fiction`, `scripture`, `note`, `other` (default: `book`)
- `--goal` — reading goal: `casual`, `reflective`, `study` (default: `study`)
- `--provider` — AI provider: `gemini` or `ollama` (default: `gemini`)
- `--dir ./test-output` — directory containing `chunks.json` (default: `./test-output`)

Outputs:
- `test-output/cards.json` — array of generated cards with source chunks

### Step 3: View in browser

```bash
pnpm --filter card-tester serve
```

Options:
- `--dir ./test-output` — directory containing JSON files (default: `./test-output`)
- `--port 3333` — server port (default: `3333`)

Open http://localhost:3333 to see the feed.

The feed viewer supports:
- All card types: discover, flashcard, quiz, glossary, contrast, passage, raw_commentary
- LaTeX rendering via KaTeX
- Interactive quiz (click to answer) and flashcard (click to reveal)
- Collapsible source chunks with associated images
- Catppuccin Mocha dark theme
