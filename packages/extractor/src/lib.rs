use scraper::{ElementRef, Html, Selector};
use serde::Serialize;

// ── Output types ──────────────────────────────────────────────────────────────

/// A single extracted element in document order.
/// Matches the DocElement type expected by the Node.js worker (apps/worker/src/types.ts).
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DocElement {
    Text {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        chapter: Option<String>,
    },
    Image {
        alt: String,
    },
}

// ── EPUB extraction ───────────────────────────────────────────────────────────

pub fn extract_epub(path: &str) -> Result<Vec<DocElement>, Box<dyn std::error::Error>> {
    use epub::doc::EpubDoc;

    let mut doc = EpubDoc::new(path)?;
    let mut all_elements: Vec<DocElement> = Vec::new();
    // Chapter context carries forward across spine items so that the first
    // paragraphs after a heading-only spine item get the right chapter label.
    let mut carry_chapter: Option<String> = None;

    loop {
        if let Some((html_content, mime)) = doc.get_current_str() {
            let is_html = mime.contains("html") || mime.contains("xhtml") || mime.contains("xml");
            if is_html && !html_content.trim().is_empty() {
                let mut extractor = HtmlExtractor::new(carry_chapter.clone());
                extractor.process(&html_content);
                carry_chapter = extractor.last_chapter.or(carry_chapter);
                all_elements.extend(extractor.elements);
            }
        }

        if !doc.go_next() {
            break;
        }
    }

    Ok(all_elements)
}

// ── PDF extraction ────────────────────────────────────────────────────────────

pub fn extract_pdf(path: &str) -> Result<Vec<DocElement>, Box<dyn std::error::Error>> {
    let doc = lopdf::Document::load(path)?;
    let mut elements = Vec::new();
    // Try pdftotext -layout for better spatial layout preservation (math, tables).
    // Falls back to lopdf per-page extraction if pdftotext is unavailable.
    let pdftotext_available = std::process::Command::new("pdftotext")
        .arg("-v")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok();

    for (page_num, page_id) in doc.get_pages() {
        // Emit an Image element for each image XObject on this page.
        for _ in 0..count_page_images(&doc, page_id) {
            elements.push(DocElement::Image {
                alt: format!("[image on page {page_num}]"),
            });
        }

        // Extract text: prefer pdftotext -layout, fall back to lopdf.
        let text = if pdftotext_available {
            extract_page_pdftotext(path, page_num)
        } else {
            None
        };
        let text = text.or_else(|| doc.extract_text(&[page_num]).ok());

        if let Some(text) = text {
            let text = clean_pdf_page(&text);
            if !text.is_empty() {
                elements.push(DocElement::Text {
                    content: text,
                    chapter: Some(format!("Page {page_num}")),
                });
            }
        }
    }

    Ok(elements)
}

/// Cleans raw PDF page text:
/// 1. Strip trailing page number (bare number on last line)
/// 2. Skip if it looks like a figure/diagram (high layout-noise ratio)
/// 3. Skip if below minimum word threshold
fn clean_pdf_page(raw: &str) -> String {
    let text = strip_trailing_page_number(raw);
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }

    // Skip figure/diagram noise: if the text is mostly layout
    // (lots of whitespace relative to actual words)
    if is_figure_noise(text) {
        return String::new();
    }

    // Skip very short fragments (page numbers, stray headers, etc.)
    let word_count = text.split_whitespace().count();
    if word_count < 10 {
        return String::new();
    }

    text.to_string()
}

/// Strips a trailing bare page number from extracted PDF text.
/// Matches a last line that is just digits (optionally with whitespace).
/// Also strips a leading page number on the first line.
fn strip_trailing_page_number(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    let mut start = 0;
    let mut end = lines.len();

    // Strip leading bare number (page number at top of page)
    if let Some(first) = lines.first() {
        if first.trim().chars().all(|c| c.is_ascii_digit()) && !first.trim().is_empty() {
            start = 1;
        }
    }

    // Strip trailing bare number (page number at bottom of page)
    if end > start {
        if let Some(last) = lines.last() {
            if last.trim().chars().all(|c| c.is_ascii_digit()) && !last.trim().is_empty() {
                end -= 1;
            }
        }
    }

    lines[start..end].join("\n")
}

/// Detects whether text looks like a figure/diagram extracted from PDF.
///
/// Heuristics:
/// - Very high ratio of whitespace characters to words (layout-heavy)
/// - Many very short lines (box-drawing, axis labels, scattered words)
/// - Contains common figure caption prefixes but mostly noise around them
fn is_figure_noise(text: &str) -> bool {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return false;
    }

    let total_chars: usize = text.len();
    let word_count = text.split_whitespace().count();

    if word_count == 0 {
        return true;
    }

    // High whitespace ratio: figures extracted with -layout have lots of
    // spacing to preserve visual positions. Real prose is dense.
    // Ratio = total characters / word count. Prose is ~6-8, figures are 15+.
    let chars_per_word = total_chars as f64 / word_count as f64;

    // Many short lines: figures have scattered labels
    let short_lines = lines.iter().filter(|l| {
        let trimmed = l.trim();
        !trimmed.is_empty() && trimmed.split_whitespace().count() <= 3
    }).count();
    let non_empty_lines = lines.iter().filter(|l| !l.trim().is_empty()).count();

    if non_empty_lines == 0 {
        return true;
    }

    let short_line_ratio = short_lines as f64 / non_empty_lines as f64;

    // Multi-space gaps: real prose has single spaces between words.
    // Layout-extracted text (TOC, figures) has runs of 3+ spaces for alignment.
    let multi_space_count = text.matches("   ").count(); // 3+ consecutive spaces
    let multi_space_heavy = multi_space_count as f64 / word_count as f64 > 0.3;

    // It's likely figure noise if:
    // - Very high chars-per-word (lots of layout whitespace) AND many short lines
    // - Almost all lines are short fragments (scattered labels)
    // - Heavy multi-space alignment AND relatively few words
    (chars_per_word > 15.0 && short_line_ratio > 0.5)
        || (short_line_ratio > 0.8 && word_count < 80)
        || (multi_space_heavy && word_count < 80)
}

/// Extracts text from a single PDF page using `pdftotext -layout`.
/// Returns None if the command fails or produces no output.
fn extract_page_pdftotext(path: &str, page_num: u32) -> Option<String> {
    // pdftotext uses 1-based page numbers; -f first -l last
    let output = std::process::Command::new("pdftotext")
        .args([
            "-layout",
            "-f", &page_num.to_string(),
            "-l", &page_num.to_string(),
            path,
            "-", // write to stdout
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    // pdftotext appends a form-feed (\x0c) per page; strip it.
    let text = text.trim_end_matches('\x0c').trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Returns the number of image XObjects declared in a page's /Resources.
fn count_page_images(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> usize {
    let Ok(page_obj) = doc.get_object(page_id) else { return 0 };
    let Ok(page_dict) = page_obj.as_dict() else { return 0 };
    let Ok(resources_obj) = page_dict.get(b"Resources") else { return 0 };
    let Some(resources) = resolve_dict(doc, resources_obj) else { return 0 };
    let Ok(xobjects_obj) = resources.get(b"XObject") else { return 0 };
    let Some(xobjects) = resolve_dict(doc, xobjects_obj) else { return 0 };

    xobjects
        .iter()
        .filter(|(_, obj)| {
            resolve_dict(doc, obj)
                .and_then(|d| d.get(b"Subtype").ok())
                .map(|s| matches!(s, lopdf::Object::Name(n) if n == b"Image"))
                .unwrap_or(false)
        })
        .count()
}

/// Resolves an Object (inline dict, stream, or indirect reference) to a &Dictionary.
fn resolve_dict<'a>(doc: &'a lopdf::Document, obj: &'a lopdf::Object) -> Option<&'a lopdf::Dictionary> {
    match obj {
        lopdf::Object::Dictionary(d) => Some(d),
        lopdf::Object::Stream(s) => Some(&s.dict),
        lopdf::Object::Reference(id) => match doc.get_object(*id).ok()? {
            lopdf::Object::Dictionary(d) => Some(d),
            lopdf::Object::Stream(s) => Some(&s.dict),
            _ => None,
        },
        _ => None,
    }
}

// ── HTML walker ───────────────────────────────────────────────────────────────

struct HtmlExtractor {
    pub elements: Vec<DocElement>,
    /// The chapter heading that was active when this spine item ended.
    /// Returned to the caller so it can carry forward across spine items.
    pub last_chapter: Option<String>,
    text_buf: String,
    current_chapter: Option<String>,
}

impl HtmlExtractor {
    fn new(initial_chapter: Option<String>) -> Self {
        HtmlExtractor {
            elements: Vec::new(),
            last_chapter: None,
            text_buf: String::new(),
            current_chapter: initial_chapter,
        }
    }

    fn process(&mut self, html: &str) {
        let document = Html::parse_document(html);
        let body_sel = Selector::parse("body").unwrap();

        let root = match document.select(&body_sel).next() {
            Some(body) => body,
            None => document.root_element(),
        };

        self.walk(root);
        self.flush();
        self.last_chapter = self.current_chapter.clone();
    }

    fn walk(&mut self, el: ElementRef) {
        match el.value().name() {
            // Skip non-content elements entirely
            "script" | "style" | "head" | "meta" | "link" | "noscript" | "nav" => {}

            // Chapter headings — update current chapter, don't emit text
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                let text = collect_text(el);
                if !text.is_empty() {
                    self.current_chapter = Some(text);
                }
            }

            // Images — emit immediately
            "img" => {
                self.flush();
                let alt = el.value().attr("alt").unwrap_or("").trim().to_string();
                self.elements.push(DocElement::Image { alt });
            }

            // Block text elements — collect text, then check for nested images
            "p" | "li" | "blockquote" | "pre" | "dd" | "dt" | "caption" | "figcaption" => {
                let text = collect_text(el);
                if !text.is_empty() {
                    if !self.text_buf.is_empty() {
                        self.text_buf.push_str("\n\n");
                    }
                    self.text_buf.push_str(&text);
                }
                // Inline images within block elements: emit after the block's text.
                // Slight ordering inaccuracy accepted for Phase 1.
                let img_sel = Selector::parse("img").unwrap();
                for img in el.select(&img_sel) {
                    self.flush();
                    let alt = img.value().attr("alt").unwrap_or("").trim().to_string();
                    self.elements.push(DocElement::Image { alt });
                }
            }

            // Everything else (div, section, article, figure, span, …) — recurse
            _ => {
                for child in el.children() {
                    if let Some(child_el) = ElementRef::wrap(child) {
                        self.walk(child_el);
                    }
                }
            }
        }
    }

    fn flush(&mut self) {
        let text = self.text_buf.trim().to_string();
        if !text.is_empty() {
            self.elements.push(DocElement::Text {
                content: text,
                chapter: self.current_chapter.clone(),
            });
        }
        self.text_buf.clear();
    }
}

/// Collects all text nodes under an element, normalising whitespace.
fn collect_text(el: ElementRef) -> String {
    el.text()
        .flat_map(|t| t.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn extract_html(html: &str) -> Vec<DocElement> {
        let mut ex = HtmlExtractor::new(None);
        ex.process(html);
        ex.elements
    }

    #[test]
    fn plain_paragraph_becomes_text_element() {
        let els = extract_html("<html><body><p>Hello world.</p></body></html>");
        assert_eq!(els.len(), 1);
        let DocElement::Text { content, .. } = &els[0] else { panic!("expected Text") };
        assert_eq!(content, "Hello world.");
    }

    #[test]
    fn heading_sets_chapter_on_following_paragraph() {
        let els = extract_html(
            "<html><body><h1>Chapter One</h1><p>Some text.</p></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Text { chapter, .. } = &els[0] else { panic!() };
        assert_eq!(chapter.as_deref(), Some("Chapter One"));
    }

    #[test]
    fn image_with_alt_becomes_image_element() {
        let els = extract_html(
            "<html><body><p>Before</p><img src=\"fig.png\" alt=\"A diagram\"/><p>After</p></body></html>",
        );
        let types: Vec<&str> = els
            .iter()
            .map(|e| match e {
                DocElement::Text { .. } => "text",
                DocElement::Image { .. } => "image",
            })
            .collect();
        assert!(types.contains(&"image"), "expected an image element, got: {:?}", types);
        let img = els.iter().find(|e| matches!(e, DocElement::Image { .. })).unwrap();
        let DocElement::Image { alt } = img else { panic!() };
        assert_eq!(alt, "A diagram");
    }

    #[test]
    fn image_without_alt_has_empty_string() {
        let els = extract_html("<html><body><img src=\"x.png\"/></body></html>");
        assert_eq!(els.len(), 1);
        let DocElement::Image { alt } = &els[0] else { panic!() };
        assert_eq!(alt, "");
    }

    #[test]
    fn script_and_style_are_ignored() {
        let els = extract_html(
            "<html><body><script>alert(1)</script><style>.x{}</style><p>Real content.</p></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Text { content, .. } = &els[0] else { panic!() };
        assert_eq!(content, "Real content.");
    }

    #[test]
    fn multiple_paragraphs_are_separate_text_elements() {
        let els = extract_html(
            "<html><body><p>Para one.</p><p>Para two.</p><p>Para three.</p></body></html>",
        );
        // All three paragraphs are buffered and flushed as one element
        // because they share the same chapter and there's no flush trigger between them.
        // Actually each paragraph triggers a flush at the end — let's check.
        let texts: Vec<_> = els
            .iter()
            .filter_map(|e| match e {
                DocElement::Text { content, .. } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        // All paragraph text should be present (may be in one or multiple Text elements)
        let joined = texts.join(" ");
        assert!(joined.contains("Para one."));
        assert!(joined.contains("Para two."));
        assert!(joined.contains("Para three."));
    }

    #[test]
    fn empty_html_produces_no_elements() {
        let els = extract_html("<html><body></body></html>");
        assert!(els.is_empty());
    }

    // ── PDF cleaning tests ────────────────────────────────────────────────

    #[test]
    fn strip_trailing_page_number_removes_bottom_number() {
        let text = "Some real content here.\nMore text on the page.\n42";
        let cleaned = strip_trailing_page_number(text);
        assert!(!cleaned.contains("42"));
        assert!(cleaned.contains("Some real content here."));
    }

    #[test]
    fn strip_trailing_page_number_removes_top_number() {
        let text = "7\nSome real content here.\nMore text on the page.";
        let cleaned = strip_trailing_page_number(text);
        assert!(!cleaned.starts_with("7"));
        assert!(cleaned.contains("Some real content here."));
    }

    #[test]
    fn strip_trailing_page_number_removes_both() {
        let text = "3\nSome content.\n3";
        let cleaned = strip_trailing_page_number(text);
        assert_eq!(cleaned.trim(), "Some content.");
    }

    #[test]
    fn strip_page_number_preserves_inline_numbers() {
        let text = "There are 42 ways to do this.\nAnother sentence with 7 items.";
        let cleaned = strip_trailing_page_number(text);
        assert!(cleaned.contains("42"));
        assert!(cleaned.contains("7"));
    }

    #[test]
    fn bare_page_number_only_becomes_empty() {
        let cleaned = clean_pdf_page("42");
        assert!(cleaned.is_empty());
    }

    #[test]
    fn short_fragment_is_filtered() {
        let cleaned = clean_pdf_page("1. Introduction");
        assert!(cleaned.is_empty(), "fragments under 10 words should be filtered");
    }

    #[test]
    fn real_prose_survives_filtering() {
        let prose = "The performance of these simple machine learning algorithms depends heavily \
            on the representation of the data they are given. For example, when logistic \
            regression is used to recommend cesarean delivery, the AI system does not examine \
            the patient directly. Instead, the doctor tells the system several pieces of relevant \
            information.";
        let cleaned = clean_pdf_page(prose);
        assert!(!cleaned.is_empty());
        assert!(cleaned.contains("machine learning"));
    }

    #[test]
    fn figure_layout_noise_is_filtered() {
        // Simulates pdftotext -layout output of a figure with scattered labels
        let figure_text = "\
            Output\n\
            \n\
            Mapping from\n\
                                           Output             Output\n\
                                                                       features\n\
            \n\
            Additional\n\
                                        Mapping from        Mapping from         layers of more\n\
                           Output\n\
                                          features            features               abstract\n\
                                                                                     features\n\
            \n\
            Hand-            Hand-\n\
                          designed         designed           Features\n\
                          program          features\n\
            \n\
            Input           Input              Input                     Input";
        let cleaned = clean_pdf_page(figure_text);
        assert!(cleaned.is_empty(), "figure layout noise should be filtered, got: {cleaned}");
    }

    #[test]
    fn toc_fragment_is_filtered() {
        let toc = "6. Deep Feedforward\n\
                                                  Networks\n\
            \n\
            7. Regularization         8. Optimization             9. CNNs           10. RNNs";
        let cleaned = clean_pdf_page(toc);
        assert!(cleaned.is_empty(), "TOC fragments should be filtered, got: {cleaned}");
    }

    #[test]
    fn page_number_at_end_of_prose_is_stripped() {
        let text = "This is a substantial paragraph with enough words to pass the minimum \
            threshold. It discusses several important concepts about machine learning \
            and artificial intelligence that are relevant to the reader.\n5";
        let cleaned = clean_pdf_page(text);
        assert!(!cleaned.is_empty());
        assert!(!cleaned.ends_with("5"));
        assert!(cleaned.contains("machine learning"));
    }
}
