use serde::{Deserialize, Serialize};

/// A raw paragraph-level unit produced by Pass 1 (Rust).
/// Segments preserve every paragraph boundary and carry metadata so that
/// Pass 2 (AI) can decide which segments to merge, split, or keep as-is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub content: String,
    pub word_count: usize,
    pub segment_index: usize,
    pub chapter: Option<String>,
    pub language: String,
    /// True when this segment starts a new chapter/section.
    pub is_chapter_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Chunk {
    pub content: String,
    pub word_count: usize,
    pub chunk_index: usize,
    pub chapter: Option<String>,
    pub language: String, // "en" | "sa" (Sanskrit/Devanagari)
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChunkOptions {
    pub min_words: usize,
    pub max_words: usize,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            min_words: 200,
            max_words: 400,
        }
    }
}

/// Minimum words for a segment to be kept. Shorter paragraphs are noise
/// (page numbers, headers, single-line labels, Roman numeral page refs).
const MIN_SEGMENT_WORDS: usize = 10;

/// Pass 1: Splits text into raw segments at paragraph and chapter boundaries.
/// Each paragraph becomes its own segment — no merging, no word-count windows.
/// Paragraphs below MIN_SEGMENT_WORDS or that look like layout noise are dropped.
/// This output is designed to be fed to an AI for boundary refinement (Pass 2).
pub fn segment(text: &str) -> Vec<Segment> {
    let paragraphs = split_paragraphs(text);
    let mut result: Vec<Segment> = Vec::new();
    let mut current_chapter: Option<String> = None;

    for para in paragraphs {
        if para.is_empty() {
            continue;
        }

        if let Some(chapter) = detect_chapter(para) {
            current_chapter = Some(chapter);
            continue;
        }

        let wc = count_words(para);

        // Drop tiny fragments (page numbers, headers, Roman numerals, labels)
        if wc < MIN_SEGMENT_WORDS {
            continue;
        }

        // Drop layout noise (figure labels, TOC entries, notation tables with
        // lots of multi-space alignment)
        if is_layout_noise(para) {
            continue;
        }

        let is_chapter_start = result.is_empty()
            || result.last().map_or(false, |prev| prev.chapter != current_chapter);
        let language = detect_language(para).to_string();

        result.push(Segment {
            content: para.to_string(),
            word_count: wc,
            segment_index: result.len(),
            chapter: current_chapter.clone(),
            language,
            is_chapter_start,
        });
    }

    result
}

/// Mechanical chunking (fallback when AI is unavailable).
/// Merges segments greedily within the word-count window, respecting chapter
/// boundaries. Never breaks mid-sentence.
pub fn chunk(text: &str, options: &ChunkOptions) -> Vec<Chunk> {
    let segments = segment(text);
    chunks_from_segments(&segments, options)
}

/// Merges a slice of segments into chunks using the mechanical word-count
/// window. Useful both as a fallback and for post-AI assembly.
pub fn chunks_from_segments(segments: &[Segment], options: &ChunkOptions) -> Vec<Chunk> {
    let mut result: Vec<Chunk> = Vec::new();
    let mut buffer: Vec<&str> = Vec::new();
    let mut buffer_words: usize = 0;
    let mut current_chapter: Option<String> = None;

    for seg in segments {
        // Chapter change — flush
        if seg.is_chapter_start && !buffer.is_empty() {
            flush_segment_buffer(&mut buffer, &mut buffer_words, &current_chapter, &mut result);
        }
        current_chapter = seg.chapter.clone();

        let para_words = seg.word_count;

        // Oversized single segment — split on sentences
        if para_words > options.max_words {
            flush_segment_buffer(&mut buffer, &mut buffer_words, &current_chapter, &mut result);
            for sentence_chunk in split_on_sentences(&seg.content, options) {
                let wc = count_words(&sentence_chunk);
                result.push(make_chunk(sentence_chunk, wc, result.len(), &current_chapter));
            }
            continue;
        }

        // Adding this segment would overflow — flush first
        if buffer_words + para_words > options.max_words && buffer_words >= options.min_words {
            flush_segment_buffer(&mut buffer, &mut buffer_words, &current_chapter, &mut result);
        }

        buffer.push(&seg.content);
        buffer_words += para_words;
    }

    flush_segment_buffer(&mut buffer, &mut buffer_words, &current_chapter, &mut result);

    result
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn flush_segment_buffer(
    buffer: &mut Vec<&str>,
    buffer_words: &mut usize,
    chapter: &Option<String>,
    result: &mut Vec<Chunk>,
) {
    if buffer.is_empty() {
        return;
    }
    let content = buffer.join("\n\n");
    let wc = *buffer_words;
    let idx = result.len();
    result.push(make_chunk(content, wc, idx, chapter));
    buffer.clear();
    *buffer_words = 0;
}

fn make_chunk(content: String, word_count: usize, chunk_index: usize, chapter: &Option<String>) -> Chunk {
    let language = detect_language(&content).to_string();
    Chunk {
        content,
        word_count,
        chunk_index,
        chapter: chapter.clone(),
        language,
    }
}

/// Splits on blank lines. Handles both \n\n and \r\n\r\n.
fn split_paragraphs(text: &str) -> Vec<&str> {
    // Normalise Windows line endings first, then split on double newline
    // We work with slices to avoid allocation.
    // For \r\n files we use a simple two-pass: callers should normalise first,
    // but we handle the common case by also treating \r\n\r\n as a separator.
    text.split("\n\n")
        .flat_map(|s| s.split("\r\n\r\n"))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Detects whether a paragraph is a chapter/section heading.
/// Returns the clean heading text if so.
fn detect_chapter(para: &str) -> Option<String> {
    // Only consider the first line of the paragraph
    let line = para.lines().next().unwrap_or("").trim();

    // Reject anything suspiciously long
    if line.len() > 80 || line.is_empty() {
        return None;
    }

    // Markdown heading: # Title, ## Title, etc.
    if line.starts_with('#') {
        return Some(line.trim_start_matches('#').trim().to_string());
    }

    // Chapter/Part/Book keywords (case-insensitive)
    let lower = line.to_lowercase();
    let keywords = [
        "chapter ", "part ", "book ", "section ",
        "prologue", "epilogue", "preface", "introduction", "conclusion",
        "afterword", "appendix",
    ];
    if keywords.iter().any(|kw| lower.starts_with(kw)) {
        return Some(line.to_string());
    }

    // All-caps line (Roman numeral chapters, etc.) — short enough to be a heading.
    //
    // Require >= 2 tokens whose *alphabetic portion* is >= 2 characters.
    // This stops false-positives on math expressions like "E = MC²":
    //   "E"  → 1 alpha char  → excluded
    //   "="  → 0 alpha chars → excluded
    //   "MC²"→ 2 alpha chars → included (but that's only 1 qualifying token)
    // A real heading like "PART ONE" has two qualifying tokens.
    let has_letters = line.chars().any(|c| c.is_alphabetic());
    let all_caps = line.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
    let alpha_word_count = line
        .split_whitespace()
        .filter(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 2)
        .count();
    if has_letters && all_caps && alpha_word_count >= 2 && line.len() < 60 {
        return Some(line.to_string());
    }

    None
}

/// Detects layout noise: text with lots of multi-space alignment gaps,
/// typical of figures, tables of contents, and notation reference tables
/// extracted from PDFs via pdftotext -layout.
fn is_layout_noise(text: &str) -> bool {
    let word_count = count_words(text);
    if word_count == 0 {
        return true;
    }

    // Count runs of 3+ consecutive spaces — layout alignment gaps.
    // Real prose has single spaces between words.
    let multi_space_runs = text
        .as_bytes()
        .windows(3)
        .filter(|w| w == b"   ")
        .count();

    // Ratio of multi-space runs to words. Prose ≈ 0, layout > 0.3.
    let gap_ratio = multi_space_runs as f64 / word_count as f64;

    // Lines analysis
    let lines: Vec<&str> = text.lines().collect();
    let non_empty: Vec<&&str> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
    if non_empty.is_empty() {
        return true;
    }

    let short_lines = non_empty
        .iter()
        .filter(|l| l.trim().split_whitespace().count() <= 3)
        .count();
    let short_ratio = short_lines as f64 / non_empty.len() as f64;

    // Layout noise if: heavy multi-space alignment, or mostly short scattered lines
    (gap_ratio > 0.3 && word_count < 120)
        || (short_ratio > 0.7 && word_count < 80)
}

/// Detects the primary language. Returns "sa" if > 15% of non-whitespace
/// characters are Devanagari (U+0900–U+097F), otherwise "en".
fn detect_language(text: &str) -> &'static str {
    let total: usize = text.chars().filter(|c| !c.is_whitespace()).count();
    if total == 0 {
        return "en";
    }
    let devanagari: usize = text
        .chars()
        .filter(|&c| ('\u{0900}'..='\u{097F}').contains(&c))
        .count();
    if devanagari * 100 / total > 15 {
        "sa"
    } else {
        "en"
    }
}

/// Counts whitespace-separated tokens.
pub fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Splits an oversized paragraph on sentence boundaries, grouping sentences
/// into chunks that stay within `options.max_words`.
fn split_on_sentences(text: &str, options: &ChunkOptions) -> Vec<String> {
    let sentences = extract_sentences(text);

    if sentences.is_empty() {
        return vec![text.trim().to_string()];
    }

    let mut result: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut current_words: usize = 0;

    for sentence in &sentences {
        let wc = count_words(sentence);
        if current_words + wc > options.max_words && !current.is_empty() {
            result.push(current.join(" "));
            current.clear();
            current_words = 0;
        }
        current.push(sentence);
        current_words += wc;
    }

    if !current.is_empty() {
        result.push(current.join(" "));
    }

    result
}

/// Splits text into individual sentences on `. `, `? `, `! ` boundaries
/// where the next character is uppercase (avoids splitting "Dr. Smith").
fn extract_sentences(text: &str) -> Vec<&str> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let mut sentences: Vec<&str> = Vec::new();
    let mut last: usize = 0;

    let mut i = 0;
    while i + 2 < n {
        let (byte_i, c) = chars[i];
        let (_, space_c) = chars[i + 1];
        let (byte_next, next_c) = chars[i + 2];

        if matches!(c, '.' | '?' | '!') && space_c == ' ' && next_c.is_uppercase() {
            let end = byte_i + c.len_utf8(); // byte just after the punctuation
            let sentence = text[last..end].trim();
            if !sentence.is_empty() {
                sentences.push(sentence);
            }
            last = byte_next;
        }
        i += 1;
    }

    // Remainder
    let remainder = text[last..].trim();
    if !remainder.is_empty() {
        sentences.push(remainder);
    }

    sentences
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_returns_no_chunks() {
        let chunks = chunk("", &ChunkOptions::default());
        assert!(chunks.is_empty());
    }

    #[test]
    fn whitespace_only_returns_no_chunks() {
        let chunks = chunk("   \n\n   \n\n   ", &ChunkOptions::default());
        assert!(chunks.is_empty());
    }

    // Helper: generates a paragraph with exactly n words of prose-like text.
    fn prose(n: usize) -> String {
        let words = "the quick brown fox jumps over the lazy dog and then runs away into the forest";
        words.split_whitespace().cycle().take(n).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn small_text_becomes_single_chunk() {
        let text = format!("{}\n\n{}", prose(15), prose(15));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chunk_index, 0);
        assert_eq!(chunks[0].language, "en");
    }

    #[test]
    fn chunks_stay_within_max_words() {
        let para = prose(50);
        let text = std::iter::repeat(para.as_str()).take(20).collect::<Vec<_>>().join("\n\n");
        let opts = ChunkOptions { min_words: 200, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert!(!chunks.is_empty());
        for c in &chunks {
            assert!(
                c.word_count <= opts.max_words,
                "chunk {} has {} words, max is {}",
                c.chunk_index, c.word_count, opts.max_words
            );
        }
    }

    #[test]
    fn chunk_indices_are_sequential() {
        let para = prose(50);
        let text = std::iter::repeat(para.as_str()).take(20).collect::<Vec<_>>().join("\n\n");
        let opts = ChunkOptions { min_words: 200, max_words: 400 };
        let chunks = chunk(&text, &opts);
        for (i, c) in chunks.iter().enumerate() {
            assert_eq!(c.chunk_index, i);
        }
    }

    #[test]
    fn markdown_chapter_headings_are_detected() {
        let text = format!("# Chapter One\n\n{}\n\n# Chapter Two\n\n{}", prose(20), prose(20));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chapter, Some("Chapter One".to_string()));
        assert_eq!(chunks[1].chapter, Some("Chapter Two".to_string()));
    }

    #[test]
    fn keyword_chapter_headings_are_detected() {
        let text = format!("Chapter 1: The Beginning\n\n{}\n\nChapter 2: The End\n\n{}", prose(20), prose(20));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].chapter.as_deref().unwrap_or("").contains("Chapter 1"));
        assert!(chunks[1].chapter.as_deref().unwrap_or("").contains("Chapter 2"));
    }

    #[test]
    fn all_caps_heading_detected() {
        let text = format!("PART ONE\n\n{}\n\nPART TWO\n\n{}", prose(20), prose(20));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chapter, Some("PART ONE".to_string()));
    }

    #[test]
    fn devanagari_detected_as_sanskrit() {
        // 12 Devanagari words — above minimum threshold
        let text = "अग्निमीळे पुरोहितं यज्ञस्य देवमृत्विजम् होतारं रत्नधातमम् अग्निः पूर्वेभिः ऋषिभिः ईड्यः नूतनैः उत";
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(text, &opts);
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].language, "sa");
    }

    #[test]
    fn english_text_detected_as_english() {
        let text = prose(15);
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].language, "en");
    }

    #[test]
    fn oversized_paragraph_splits_on_sentences() {
        let sentence = "The cat sat on the mat and then walked away quickly. ";
        let text = sentence.repeat(50); // ~500 words
        let opts = ChunkOptions { min_words: 200, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert!(chunks.len() >= 2, "expected at least 2 chunks from 500-word paragraph");
        for c in &chunks {
            assert!(c.word_count <= opts.max_words);
        }
    }

    #[test]
    fn count_words_basic() {
        assert_eq!(count_words("one two three"), 3);
        assert_eq!(count_words("  spaces   everywhere  "), 2);
        assert_eq!(count_words(""), 0);
    }

    #[test]
    fn math_expression_not_detected_as_chapter() {
        // "E = MC²" is short and will be filtered by MIN_SEGMENT_WORDS,
        // but the important thing is it's not treated as a chapter heading.
        let text = format!("E = MC² and the energy equation shows that mass and energy are equivalent in this fundamental relationship of physics\n\n{}", prose(20));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert!(!chunks.is_empty());
        assert!(chunks[0].chapter.is_none());
        assert!(chunks[0].content.contains("MC²"));
    }

    #[test]
    fn single_allcaps_word_not_detected_as_chapter() {
        // "DNA" is too short and will be filtered, but it shouldn't be a chapter heading either.
        // Test with enough words to survive filtering.
        let text = format!("DNA is the molecule that carries genetic information in all living organisms on the planet earth\n\n{}", prose(15));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert!(!chunks.is_empty());
        assert!(chunks[0].chapter.is_none());
    }

    #[test]
    fn chapter_before_first_content() {
        let text = format!("# Prelude\n\n{}", prose(20));
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(&text, &opts);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chapter, Some("Prelude".to_string()));
    }

    #[test]
    fn short_fragments_are_filtered() {
        let text = "Page 1\n\nCONTENTS\n\nxiii\n\nNotation";
        let opts = ChunkOptions { min_words: 1, max_words: 400 };
        let chunks = chunk(text, &opts);
        assert!(chunks.is_empty(), "short fragments should be filtered out");
    }

    #[test]
    fn layout_noise_is_filtered() {
        let text = "Output\n\n   CAR       PERSON   ANIMAL\n\n                                    (object identity)\n\n3rd hidden layer\n\n                                     (object parts)";
        let segs = segment(text);
        assert!(segs.is_empty(), "layout noise should produce no segments");
    }

    // ── Segment tests ─────────────────────────────────────────────────────────

    #[test]
    fn segment_empty_input() {
        let segs = segment("");
        assert!(segs.is_empty());
    }

    #[test]
    fn segment_one_paragraph_per_segment() {
        let p1 = prose(15);
        let p2 = prose(12);
        let p3 = prose(18);
        let text = format!("{}\n\n{}\n\n{}", p1, p2, p3);
        let segs = segment(&text);
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].content, p1);
        assert_eq!(segs[1].content, p2);
        assert_eq!(segs[2].content, p3);
    }

    #[test]
    fn segment_indices_are_sequential() {
        let text = format!("{}\n\n{}\n\n{}\n\n{}", prose(15), prose(12), prose(18), prose(11));
        let segs = segment(&text);
        for (i, s) in segs.iter().enumerate() {
            assert_eq!(s.segment_index, i);
        }
    }

    #[test]
    fn segment_chapters_propagate() {
        let text = format!("# Intro\n\n{}\n\n{}\n\n# Methods\n\n{}", prose(15), prose(15), prose(15));
        let segs = segment(&text);
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].chapter, Some("Intro".to_string()));
        assert_eq!(segs[1].chapter, Some("Intro".to_string()));
        assert_eq!(segs[2].chapter, Some("Methods".to_string()));
    }

    #[test]
    fn segment_chapter_start_flag() {
        let text = format!("# Intro\n\n{}\n\n{}\n\n# Methods\n\n{}", prose(15), prose(15), prose(15));
        let segs = segment(&text);
        assert!(segs[0].is_chapter_start, "first segment after a heading");
        assert!(!segs[1].is_chapter_start, "same chapter, not a start");
        assert!(segs[2].is_chapter_start, "new chapter");
    }

    #[test]
    fn segment_word_counts_are_accurate() {
        let text = format!("{}\n\n{}", prose(15), prose(12));
        let segs = segment(&text);
        assert_eq!(segs[0].word_count, 15);
        assert_eq!(segs[1].word_count, 12);
    }

    #[test]
    fn segment_language_per_segment() {
        let sanskrit = "अग्निमीळे पुरोहितं यज्ञस्य देवमृत्विजम् होतारं रत्नधातमम् अग्निः पूर्वेभिः ऋषिभिः ईड्यः नूतनैः उत";
        let text = format!("{}\n\n{}", prose(15), sanskrit);
        let segs = segment(&text);
        assert_eq!(segs[0].language, "en");
        assert_eq!(segs[1].language, "sa");
    }

    #[test]
    fn segment_no_content_lost() {
        let p1 = prose(15);
        let p2 = prose(12);
        let p3 = prose(18);
        let p4 = prose(11);
        let text = format!("{}\n\n{}\n\n# Chapter\n\n{}\n\n{}", p1, p2, p3, p4);
        let segs = segment(&text);
        let all_content: Vec<&str> = segs.iter().map(|s| s.content.as_str()).collect();
        assert!(all_content.contains(&p1.as_str()));
        assert!(all_content.contains(&p2.as_str()));
        assert!(all_content.contains(&p3.as_str()));
        assert!(all_content.contains(&p4.as_str()));
    }

    #[test]
    fn segment_drops_short_fragments() {
        let text = format!("Notation\n\n{}\n\nxiii\n\n{}", prose(20), prose(15));
        let segs = segment(&text);
        assert_eq!(segs.len(), 2, "short fragments should be dropped");
        // "Notation" and "xiii" should not appear
        for s in &segs {
            assert!(s.word_count >= MIN_SEGMENT_WORDS);
        }
    }

    #[test]
    fn chunks_from_segments_matches_chunk() {
        let text = "word ".repeat(50);
        let text = std::iter::repeat(text.as_str()).take(20).collect::<Vec<_>>().join("\n\n");
        let opts = ChunkOptions { min_words: 200, max_words: 400 };
        let direct = chunk(&text, &opts);
        let via_segments = chunks_from_segments(&segment(&text), &opts);
        assert_eq!(direct.len(), via_segments.len());
        for (d, v) in direct.iter().zip(via_segments.iter()) {
            assert_eq!(d.content, v.content);
            assert_eq!(d.word_count, v.word_count);
        }
    }
}
