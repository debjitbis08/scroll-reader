#!/usr/bin/env bash
#
# Analyze image formats used across all documents in a Calibre library.
#
# Usage: ./scripts/analyze-library-images.sh [LIBRARY_DIR]
#        Defaults to ~/Calibre Library/
#
# Requires: pdfimages (poppler-utils), unzip, python3 (for mobi/azw3 via KindleUnpack or basic analysis)
#
# Output: per-document image stats + a final summary of format distribution.
#

set -euo pipefail

LIBRARY="${1:-$HOME/Calibre Library}"
TIMEOUT=60  # seconds per file
TMPDIR=$(mktemp -d /tmp/analyze-images-XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

# Accumulators (format -> count)
declare -A FORMAT_COUNT
declare -A FORMAT_BYTES
declare -A FORMAT_PER_DOCTYPE  # "doctype:format" -> count

TOTAL_DOCS=0
DOCS_WITH_IMAGES=0
TOTAL_IMAGES=0

# ── PDF analysis via pdfimages ─────────────────────────────────────────────────

analyze_pdf() {
    local file="$1"
    local basename
    basename=$(basename "$file")
    TOTAL_DOCS=$((TOTAL_DOCS + 1))

    # pdfimages -list gives: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
    # We want the "enc" column (encoding) which tells us the image format
    local list_output
    list_output=$(timeout "$TIMEOUT" pdfimages -list "$file" 2>/dev/null) || {
        if [[ $? -eq 124 ]]; then
            printf "  PDF  %-50s  TIMEOUT\n" "$(echo "$basename" | cut -c1-50)"
        fi
        return 0
    }

    local doc_images=0
    while IFS= read -r line; do
        # Skip header lines
        [[ "$line" =~ ^page ]] && continue
        [[ "$line" =~ ^----- ]] && continue
        [[ -z "$line" ]] && continue

        # Columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
        local enc width height color bpc size
        enc=$(echo "$line" | awk '{print $7}')
        width=$(echo "$line" | awk '{print $4}')
        height=$(echo "$line" | awk '{print $5}')
        color=$(echo "$line" | awk '{print $6}')
        bpc=$(echo "$line" | awk '{print $8}')
        size=$(echo "$line" | awk '{print $NF}')

        # Normalize encoding names
        local format
        case "$enc" in
            jpeg)   format="jpeg" ;;
            jpx)    format="jpeg2000" ;;
            ccitt)  format="ccitt" ;;
            image)  format="raw" ;;  # raw pixel data (needs reconstruction)
            jbig2)  format="jbig2" ;;
            png)    format="png" ;;  # rare in PDFs but possible
            *)      format="$enc" ;;
        esac

        FORMAT_COUNT["$format"]=$(( ${FORMAT_COUNT["$format"]:-0} + 1 ))
        FORMAT_PER_DOCTYPE["pdf:$format"]=$(( ${FORMAT_PER_DOCTYPE["pdf:$format"]:-0} + 1 ))

        # Parse size (e.g., "123K", "1.2M", "456B")
        local bytes=0
        if [[ "$size" =~ ^([0-9.]+)([KMB])$ ]]; then
            local num="${BASH_REMATCH[1]}"
            local unit="${BASH_REMATCH[2]}"
            case "$unit" in
                B) bytes=$(printf "%.0f" "$num") ;;
                K) bytes=$(printf "%.0f" "$(echo "$num * 1024" | bc)") ;;
                M) bytes=$(printf "%.0f" "$(echo "$num * 1048576" | bc)") ;;
            esac
        fi
        FORMAT_BYTES["$format"]=$(( ${FORMAT_BYTES["$format"]:-0} + bytes ))

        doc_images=$((doc_images + 1))
        TOTAL_IMAGES=$((TOTAL_IMAGES + 1))
    done <<< "$list_output"

    if [[ $doc_images -gt 0 ]]; then
        DOCS_WITH_IMAGES=$((DOCS_WITH_IMAGES + 1))
        printf "  PDF  %-50s  %4d images\n" "$(echo "$basename" | cut -c1-50)" "$doc_images"
    fi
}

# ── EPUB analysis via unzip ────────────────────────────────────────────────────

analyze_epub() {
    local file="$1"
    local basename
    basename=$(basename "$file")
    TOTAL_DOCS=$((TOTAL_DOCS + 1))

    local doc_images=0

    # List files inside the EPUB (ZIP archive) and filter for image extensions
    local file_list
    file_list=$(timeout "$TIMEOUT" unzip -l "$file" 2>/dev/null | grep -iE '\.(jpe?g|png|gif|svg|webp|bmp|tiff?|avif|ico)$' || true)

    while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # unzip -l format: "  LENGTH  DATE  TIME  NAME"
        local size name ext format
        size=$(echo "$line" | awk '{print $1}')
        name=$(echo "$line" | awk '{print $4}')
        ext="${name##*.}"
        ext=$(echo "$ext" | tr '[:upper:]' '[:lower:]')

        case "$ext" in
            jpg|jpeg) format="jpeg" ;;
            png)      format="png" ;;
            gif)      format="gif" ;;
            svg)      format="svg" ;;
            webp)     format="webp" ;;
            bmp)      format="bmp" ;;
            tif|tiff) format="tiff" ;;
            avif)     format="avif" ;;
            ico)      format="ico" ;;
            *)        format="$ext" ;;
        esac

        FORMAT_COUNT["$format"]=$(( ${FORMAT_COUNT["$format"]:-0} + 1 ))
        FORMAT_BYTES["$format"]=$(( ${FORMAT_BYTES["$format"]:-0} + size ))
        FORMAT_PER_DOCTYPE["epub:$format"]=$(( ${FORMAT_PER_DOCTYPE["epub:$format"]:-0} + 1 ))

        doc_images=$((doc_images + 1))
        TOTAL_IMAGES=$((TOTAL_IMAGES + 1))
    done <<< "$file_list"

    if [[ $doc_images -gt 0 ]]; then
        DOCS_WITH_IMAGES=$((DOCS_WITH_IMAGES + 1))
        printf "  EPUB %-50s  %4d images\n" "$(echo "$basename" | cut -c1-50)" "$doc_images"
    fi
}

# ── MOBI/AZW3 analysis ────────────────────────────────────────────────────────
# MOBI/AZW3 files embed images as sequential records after the text.
# We can detect format by reading the magic bytes of each image record,
# but a simpler approach: convert to EPUB via Calibre's ebook-convert (if available)
# and then analyze the EPUB. Alternatively, scan for magic bytes directly.

analyze_mobi() {
    local file="$1"
    local basename
    basename=$(basename "$file")
    TOTAL_DOCS=$((TOTAL_DOCS + 1))

    # Scan the binary for image magic bytes to count images by format.
    # This is approximate but gives us the right distribution.
    local doc_images=0

    # Count JPEG markers (FFD8FF)
    local jpeg_count
    jpeg_count=$(timeout "$TIMEOUT" grep -c $'\xff\xd8\xff' "$file" 2>/dev/null || echo 0)
    if [[ $jpeg_count -gt 0 ]]; then
        FORMAT_COUNT["jpeg"]=$(( ${FORMAT_COUNT["jpeg"]:-0} + jpeg_count ))
        FORMAT_PER_DOCTYPE["mobi:jpeg"]=$(( ${FORMAT_PER_DOCTYPE["mobi:jpeg"]:-0} + jpeg_count ))
        doc_images=$((doc_images + jpeg_count))
        TOTAL_IMAGES=$((TOTAL_IMAGES + jpeg_count))
    fi

    # Count PNG signatures (89504E47)
    local png_count
    png_count=$(timeout "$TIMEOUT" grep -c $'\x89PNG' "$file" 2>/dev/null || echo 0)
    if [[ $png_count -gt 0 ]]; then
        FORMAT_COUNT["png"]=$(( ${FORMAT_COUNT["png"]:-0} + png_count ))
        FORMAT_PER_DOCTYPE["mobi:png"]=$(( ${FORMAT_PER_DOCTYPE["mobi:png"]:-0} + png_count ))
        doc_images=$((doc_images + png_count))
        TOTAL_IMAGES=$((TOTAL_IMAGES + png_count))
    fi

    # Count GIF signatures (GIF89a or GIF87a)
    local gif_count
    gif_count=$(timeout "$TIMEOUT" grep -c 'GIF8[79]a' "$file" 2>/dev/null || echo 0)
    if [[ $gif_count -gt 0 ]]; then
        FORMAT_COUNT["gif"]=$(( ${FORMAT_COUNT["gif"]:-0} + gif_count ))
        FORMAT_PER_DOCTYPE["mobi:gif"]=$(( ${FORMAT_PER_DOCTYPE["mobi:gif"]:-0} + gif_count ))
        doc_images=$((doc_images + gif_count))
        TOTAL_IMAGES=$((TOTAL_IMAGES + gif_count))
    fi

    # Count BMP signatures (BM)
    local bmp_count
    bmp_count=$(grep -c 'BM' "$file" 2>/dev/null || echo 0)
    # BM is too common in text, so only count if the file is binary-heavy
    # Skip BMP counting for MOBI — too many false positives
    bmp_count=0

    if [[ $doc_images -gt 0 ]]; then
        DOCS_WITH_IMAGES=$((DOCS_WITH_IMAGES + 1))
        printf "  MOBI %-50s  %4d images\n" "$(echo "$basename" | cut -c1-50)" "$doc_images"
    fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

echo "Analyzing images in: $LIBRARY"
echo "========================================================================"
echo ""

# Process PDFs
echo "── PDFs ────────────────────────────────────────────────────────────────"
while IFS= read -r -d '' file; do
    analyze_pdf "$file"
done < <(find "$LIBRARY" -type f -name "*.pdf" -print0 2>/dev/null | sort -z)

echo ""

# Process EPUBs
echo "── EPUBs ───────────────────────────────────────────────────────────────"
while IFS= read -r -d '' file; do
    analyze_epub "$file"
done < <(find "$LIBRARY" -type f -name "*.epub" -print0 2>/dev/null | sort -z)

echo ""

# Process MOBI/AZW3
echo "── MOBI/AZW3 ─────────────────────────────────────────────────────────"
while IFS= read -r -d '' file; do
    analyze_mobi "$file"
done < <(find "$LIBRARY" -type f \( -name "*.mobi" -o -name "*.azw3" \) -print0 2>/dev/null | sort -z)

echo ""

# ── Summary ────────────────────────────────────────────────────────────────────

echo "========================================================================"
echo "SUMMARY"
echo "========================================================================"
echo ""
printf "  Total documents scanned:    %d\n" "$TOTAL_DOCS"
printf "  Documents with images:      %d\n" "$DOCS_WITH_IMAGES"
printf "  Total images found:         %d\n" "$TOTAL_IMAGES"
echo ""

echo "── Image Format Distribution ───────────────────────────────────────────"
echo ""
printf "  %-14s  %8s  %10s  %6s\n" "FORMAT" "COUNT" "TOTAL SIZE" "% OF ALL"
printf "  %-14s  %8s  %10s  %6s\n" "──────────────" "────────" "──────────" "──────"

# Sort formats by count (descending)
for format in "${!FORMAT_COUNT[@]}"; do
    echo "$format ${FORMAT_COUNT[$format]} ${FORMAT_BYTES[$format]:-0}"
done | sort -k2 -rn | while read -r format count bytes; do
    if [[ $TOTAL_IMAGES -gt 0 ]]; then
        pct=$(echo "scale=1; $count * 100 / $TOTAL_IMAGES" | bc)
    else
        pct="0.0"
    fi

    # Human-readable size
    if [[ $bytes -ge 1073741824 ]]; then
        size=$(echo "scale=1; $bytes / 1073741824" | bc)" GB"
    elif [[ $bytes -ge 1048576 ]]; then
        size=$(echo "scale=1; $bytes / 1048576" | bc)" MB"
    elif [[ $bytes -ge 1024 ]]; then
        size=$(echo "scale=1; $bytes / 1024" | bc)" KB"
    else
        size="${bytes} B"
    fi

    printf "  %-14s  %8d  %10s  %5s%%\n" "$format" "$count" "$size" "$pct"
done

echo ""

echo "── Format Distribution by Document Type ────────────────────────────────"
echo ""
printf "  %-20s  %8s\n" "DOCTYPE:FORMAT" "COUNT"
printf "  %-20s  %8s\n" "────────────────────" "────────"

for key in "${!FORMAT_PER_DOCTYPE[@]}"; do
    echo "$key ${FORMAT_PER_DOCTYPE[$key]}"
done | sort -k2 -rn | while read -r key count; do
    printf "  %-20s  %8d\n" "$key" "$count"
done

echo ""
echo "Done. Temp dir cleaned up."
