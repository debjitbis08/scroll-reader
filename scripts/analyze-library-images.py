#!/usr/bin/env python3
"""
Analyze image formats across all documents in a Calibre library.

Usage: python3 scripts/analyze-library-images.py [LIBRARY_DIR]
       Defaults to ~/Calibre Library/

Requires: pdfimages (poppler-utils), unzip
"""

import os
import sys
import subprocess
import re
from pathlib import Path
from collections import defaultdict

LIBRARY = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Calibre Library"
TIMEOUT = 60  # seconds per file

# Accumulators
format_count: dict[str, int] = defaultdict(int)
format_bytes: dict[str, int] = defaultdict(int)
format_per_doctype: dict[str, int] = defaultdict(int)  # "doctype:format" -> count
total_docs = 0
docs_with_images = 0
total_images = 0

# Per-format dimension tracking (width * height) for size distribution
format_dimensions: dict[str, list[int]] = defaultdict(list)


def human_size(b: int) -> str:
    if b >= 1 << 30:
        return f"{b / (1 << 30):.1f} GB"
    if b >= 1 << 20:
        return f"{b / (1 << 20):.1f} MB"
    if b >= 1 << 10:
        return f"{b / (1 << 10):.1f} KB"
    return f"{b} B"


def parse_size(s: str) -> int:
    """Parse pdfimages size strings like '123K', '1.2M', '456B'."""
    m = re.match(r"^([\d.]+)([KMB])$", s)
    if not m:
        return 0
    num, unit = float(m.group(1)), m.group(2)
    if unit == "B":
        return int(num)
    if unit == "K":
        return int(num * 1024)
    if unit == "M":
        return int(num * 1048576)
    return 0


def analyze_pdf(filepath: Path):
    global total_docs, docs_with_images, total_images
    total_docs += 1
    name = filepath.name[:50]

    try:
        result = subprocess.run(
            ["pdfimages", "-list", str(filepath)],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
        output = result.stdout
    except subprocess.TimeoutExpired:
        print(f"  PDF  {name:<50}  TIMEOUT")
        return
    except Exception:
        return

    doc_images = 0
    for line in output.splitlines():
        if line.startswith("page") or line.startswith("---") or not line.strip():
            continue

        parts = line.split()
        if len(parts) < 10:
            continue

        # Columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
        # Index:   0    1   2    3     4      5     6    7   8   9      10     11 12    13    14   15
        try:
            width = int(parts[3])
            height = int(parts[4])
        except (ValueError, IndexError):
            width = height = 0

        enc = parts[8]

        fmt_map = {
            "jpeg": "jpeg", "jpx": "jpeg2000", "ccitt": "ccitt",
            "image": "raw", "jbig2": "jbig2", "png": "png",
        }
        fmt = fmt_map.get(enc, enc)

        # Size is second-to-last column (last is ratio like "12%")
        size_str = parts[-2] if len(parts) >= 2 else "0B"
        size_bytes = parse_size(size_str)

        format_count[fmt] += 1
        format_bytes[fmt] += size_bytes
        format_per_doctype[f"pdf:{fmt}"] += 1
        if width and height:
            format_dimensions[fmt].append(width * height)

        doc_images += 1
        total_images += 1

    if doc_images > 0:
        docs_with_images += 1
        print(f"  PDF  {name:<50}  {doc_images:4d} images")


def analyze_epub(filepath: Path):
    global total_docs, docs_with_images, total_images
    total_docs += 1
    name = filepath.name[:50]

    try:
        result = subprocess.run(
            ["unzip", "-l", str(filepath)],
            capture_output=True, text=True, timeout=TIMEOUT,
        )
        output = result.stdout
    except subprocess.TimeoutExpired:
        print(f"  EPUB {name:<50}  TIMEOUT")
        return
    except Exception:
        return

    img_pattern = re.compile(r"\.(jpe?g|png|gif|svg|webp|bmp|tiff?|avif|ico)$", re.IGNORECASE)
    doc_images = 0

    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        fname = parts[-1]
        if not img_pattern.search(fname):
            continue

        try:
            size = int(parts[0])
        except ValueError:
            size = 0

        ext = fname.rsplit(".", 1)[-1].lower()
        ext_map = {
            "jpg": "jpeg", "jpeg": "jpeg", "png": "png", "gif": "gif",
            "svg": "svg", "webp": "webp", "bmp": "bmp",
            "tif": "tiff", "tiff": "tiff", "avif": "avif", "ico": "ico",
        }
        fmt = ext_map.get(ext, ext)

        format_count[fmt] += 1
        format_bytes[fmt] += size
        format_per_doctype[f"epub:{fmt}"] += 1

        doc_images += 1
        total_images += 1

    if doc_images > 0:
        docs_with_images += 1
        print(f"  EPUB {name:<50}  {doc_images:4d} images")


def analyze_mobi(filepath: Path):
    """Count images in MOBI/AZW3 via magic byte scanning."""
    global total_docs, docs_with_images, total_images
    total_docs += 1
    name = filepath.name[:50]

    try:
        data = filepath.read_bytes()
    except Exception:
        return

    doc_images = 0

    # JPEG: FF D8 FF
    jpeg_marker = b"\xff\xd8\xff"
    jpeg_count = data.count(jpeg_marker)
    if jpeg_count:
        format_count["jpeg"] += jpeg_count
        format_per_doctype["mobi:jpeg"] += jpeg_count
        doc_images += jpeg_count
        total_images += jpeg_count

    # PNG: 89 50 4E 47
    png_marker = b"\x89PNG"
    png_count = data.count(png_marker)
    if png_count:
        format_count["png"] += png_count
        format_per_doctype["mobi:png"] += png_count
        doc_images += png_count
        total_images += png_count

    # GIF: GIF89a or GIF87a
    gif_count = data.count(b"GIF89a") + data.count(b"GIF87a")
    if gif_count:
        format_count["gif"] += gif_count
        format_per_doctype["mobi:gif"] += gif_count
        doc_images += gif_count
        total_images += gif_count

    if doc_images > 0:
        docs_with_images += 1
        print(f"  MOBI {name:<50}  {doc_images:4d} images")


def find_files(ext: str) -> list[Path]:
    return sorted(LIBRARY.rglob(f"*.{ext}"))


# ── Main ───────────────────────────────────────────────────────────────────────

print(f"Analyzing images in: {LIBRARY}")
print("=" * 72)
print()

print("── PDFs " + "─" * 64)
for f in find_files("pdf"):
    analyze_pdf(f)
print()

print("── EPUBs " + "─" * 63)
for f in find_files("epub"):
    analyze_epub(f)
print()

print("── MOBI/AZW3 " + "─" * 59)
for f in find_files("mobi"):
    analyze_mobi(f)
for f in find_files("azw3"):
    analyze_mobi(f)
print()

# ── Summary ────────────────────────────────────────────────────────────────────

print("=" * 72)
print("SUMMARY")
print("=" * 72)
print()
print(f"  Total documents scanned:    {total_docs}")
print(f"  Documents with images:      {docs_with_images}")
print(f"  Total images found:         {total_images}")
print()

print("── Image Format Distribution " + "─" * 43)
print()
print(f"  {'FORMAT':<14}  {'COUNT':>8}  {'TOTAL SIZE':>10}  {'% OF ALL':>8}  {'AVG PX':>10}")
print(f"  {'─' * 14}  {'─' * 8}  {'─' * 10}  {'─' * 8}  {'─' * 10}")

for fmt in sorted(format_count, key=lambda k: format_count[k], reverse=True):
    count = format_count[fmt]
    size = format_bytes[fmt]
    pct = f"{count * 100 / total_images:.1f}" if total_images else "0.0"
    dims = format_dimensions.get(fmt, [])
    avg_px = f"{sum(dims) // len(dims):,}" if dims else "—"
    print(f"  {fmt:<14}  {count:>8}  {human_size(size):>10}  {pct:>7}%  {avg_px:>10}")

print()
print("── Format Distribution by Document Type " + "─" * 32)
print()
print(f"  {'DOCTYPE:FORMAT':<20}  {'COUNT':>8}")
print(f"  {'─' * 20}  {'─' * 8}")

for key in sorted(format_per_doctype, key=lambda k: format_per_doctype[k], reverse=True):
    print(f"  {key:<20}  {format_per_doctype[key]:>8}")

print()
print("Done.")
