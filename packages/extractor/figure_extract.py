#!/usr/bin/env python3
"""
Extract vector-drawn figures from PDF files using PyMuPDF.

Protocol: JSON on stdin  → JSON array on stdout
  Input:  {"file_path": "...", "output_dir": "..."}
  Output: [{"type":"image", "alt":"Figure 2.1. ...", "file":"/tmp/.../figure_2_1.png", "mime":"image/png", "page":2}, ...]

Detection strategy:
  1. Caption anchoring — find "FIGURE X.Y" text blocks, scope the figure
     region to the vertical band between the previous caption's bottom
     (or page top) and this caption's top.
  2. Drawing bbox clustering — union all vector drawing rects + text
     blocks within that band to get the full figure extent (including
     axis labels).
  3. Render & crop at 150 DPI → PNG.
"""

import json
import os
import re
import sys

import fitz  # PyMuPDF


DPI = 150
PAD = 12  # pixels of padding around the crop
CAPTION_RE = re.compile(r"^(?:\*\*)?(?:FIGURE|Figure|Fig\.?)\s+(\d+[\.\-]\d+)", re.IGNORECASE)
# Minimum number of drawing commands to consider a region a figure
MIN_DRAWINGS = 5
# Minimum crop dimension (points) to avoid tiny decorative elements
MIN_DIM = 40


def find_captions(text_blocks):
    """Find text blocks that start with a figure caption pattern."""
    captions = []
    for b in text_blocks:
        text = b[4].strip()
        m = CAPTION_RE.match(text)
        if m:
            captions.append({
                "label": m.group(1),
                "text": text,
                "bbox": fitz.Rect(b[:4]),
            })
    captions.sort(key=lambda c: c["bbox"].y0)
    return captions


def extract_figures_from_page(page, page_num, output_dir):
    """Extract all captioned figures from a single page."""
    pw, ph = page.rect.width, page.rect.height

    text_blocks = sorted(
        [b for b in page.get_text("blocks") if b[6] == 0], key=lambda b: b[1]
    )
    all_drawings = [fitz.Rect(d["rect"]) for d in page.get_drawings()]
    captions = find_captions(text_blocks)

    if not captions:
        return []

    results = []
    for i, cap in enumerate(captions):
        floor = captions[i - 1]["bbox"].y1 if i > 0 else 0
        ceiling = cap["bbox"].y0

        if ceiling - floor < MIN_DIM:
            continue

        # Drawings in the vertical band between floor and ceiling
        band_drawings = [
            r
            for r in all_drawings
            if r.y0 >= floor - 5 and r.y1 <= ceiling + 5
        ]

        if len(band_drawings) < MIN_DRAWINGS:
            continue

        draw_y0 = min(r.y0 for r in band_drawings)

        # Include text blocks that sit just above the drawings
        # (subplot titles like "KNN: K=1") — within 20pt of draw_y0
        title_gap = 20
        title_texts = [
            b for b in text_blocks
            if b[3] <= draw_y0 and b[1] >= draw_y0 - title_gap and b[1] >= floor
        ]
        fig_y0 = min(draw_y0, min((b[1] for b in title_texts), default=draw_y0))

        # Use page content margins for x-bounds.
        # Computing x from individual elements is unreliable because
        # rotated axis labels and clipped drawing paths can extend
        # beyond their reported bboxes.
        margin = pw * 0.06  # ~6% margin on each side
        fig_x0 = margin
        fig_x1 = pw - margin

        # Crop: from top of drawings to bottom of caption
        crop = fitz.Rect(fig_x0, fig_y0, fig_x1, cap["bbox"].y1)

        if crop.width < MIN_DIM or crop.height < MIN_DIM:
            continue

        # Add padding, clamp to page bounds
        crop = fitz.Rect(
            max(0, crop.x0 - PAD),
            max(0, crop.y0 - PAD),
            min(pw, crop.x1 + PAD),
            min(ph, crop.y1 + PAD),
        )

        # Render
        mat = fitz.Matrix(DPI / 72, DPI / 72)
        pix = page.get_pixmap(matrix=mat, clip=crop)

        label = cap["label"].replace(".", "_").replace("-", "_")
        filename = f"figure_{label}.png"
        filepath = os.path.join(output_dir, filename)
        pix.save(filepath)

        # Build alt text from caption (clean up markdown bold markers)
        alt = cap["text"].replace("**", "").replace("*", "")
        # Truncate to first 200 chars for alt text
        if len(alt) > 200:
            alt = alt[:197] + "..."

        results.append(
            {
                "type": "image",
                "alt": alt,
                "file": filepath,
                "mime": "image/png",
                "page": page_num,
            }
        )

    return results


def extract_figures(file_path, output_dir):
    """Extract all vector figures from a PDF."""
    os.makedirs(output_dir, exist_ok=True)

    doc = fitz.open(file_path)
    all_figures = []

    for i in range(len(doc)):
        page = doc[i]
        page_num = i + 1

        figures = extract_figures_from_page(page, page_num, output_dir)
        all_figures.extend(figures)

    doc.close()
    return all_figures


def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}), file=sys.stderr)
        sys.exit(1)

    file_path = input_data.get("file_path")
    output_dir = input_data.get("output_dir")

    if not file_path or not output_dir:
        print(
            json.dumps({"error": "file_path and output_dir are required"}),
            file=sys.stderr,
        )
        sys.exit(1)

    if not os.path.exists(file_path):
        print(
            json.dumps({"error": f"File not found: {file_path}"}), file=sys.stderr
        )
        sys.exit(1)

    figures = extract_figures(file_path, output_dir)
    json.dump(figures, sys.stdout)


if __name__ == "__main__":
    main()
