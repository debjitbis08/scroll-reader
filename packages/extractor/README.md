# Extractor

Rust binary + Python script for extracting text, code, and images from EPUB and PDF files.

## Rust Extractor

Extracts text, code blocks, and raster images (JPEG/PNG) from EPUB and PDF files.

### Build

```bash
cargo build --release
```

### Usage

JSON on stdin, JSON array of `DocElement` on stdout:

```bash
echo '{"file_path": "/path/to/book.pdf", "output_dir": "/tmp/images"}' \
  | ./target/release/extractor
```

- `file_path` (required) — path to `.epub` or `.pdf` file
- `output_dir` (optional) — directory for extracted images; if omitted, image elements have no `file` field

## Figure Extractor (Python)

Extracts vector-drawn figures from PDFs using PyMuPDF. These are figures drawn with PDF vector operators (lines, curves, fills) that don't exist as raster image objects — common in academic/scientific PDFs.

### Prerequisites

```bash
pip install pymupdf
```

### Usage

```bash
echo '{"file_path": "/path/to/book.pdf", "output_dir": "/tmp/figures"}' \
  | python3 figure_extract.py
```

Outputs a JSON array of extracted figure images:

```json
[
  {
    "type": "image",
    "alt": "FIGURE 2.1. The Advertising data set...",
    "file": "/tmp/figures/figure_2_1.png",
    "mime": "image/png",
    "page": 2
  }
]
```

### How it works

1. Finds `FIGURE X.Y` caption text blocks on each page
2. Scopes each figure to the vertical band between the previous caption and the current one
3. Unions drawing bboxes + nearby text (subplot titles) to determine crop region
4. Renders the crop at 150 DPI as PNG
