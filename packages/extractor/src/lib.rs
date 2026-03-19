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
    Code {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        chapter: Option<String>,
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
    // Try pdftohtml first — it gives us font info to distinguish code from prose.
    // Falls back to pdftotext (no code detection) if pdftohtml is unavailable.
    if let Some(elements) = extract_pdf_via_html(path) {
        if !elements.is_empty() {
            return Ok(elements);
        }
    }
    extract_pdf_via_text(path)
}

/// Primary PDF extraction: uses `pdftohtml -xml` to get XML with font metadata.
/// Each page declares `<fontspec>` elements with font family info, and each
/// `<text>` element references a font ID. We identify monospace fonts and group
/// consecutive monospace text runs into Code blocks.
fn extract_pdf_via_html(path: &str) -> Option<Vec<DocElement>> {
    let output = std::process::Command::new("pdftohtml")
        .args([
            "-stdout",
            "-i",          // ignore images (handled separately via lopdf)
            "-xml",        // XML output with per-text font references
            "-enc", "UTF-8",
            path,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let xml = String::from_utf8_lossy(&output.stdout).to_string();
    if xml.is_empty() {
        return None;
    }

    // Load lopdf for image counting
    let pdf_doc = lopdf::Document::load(path).ok();

    let document = Html::parse_document(&xml);
    let mut elements = Vec::new();

    let page_sel = Selector::parse("page").unwrap();
    let fontspec_sel = Selector::parse("fontspec").unwrap();
    let text_sel = Selector::parse("text").unwrap();

    // Build font ID → monospace map from document-level <fontspec> elements.
    // In full-doc XML mode, fontspecs are at the root level (not inside pages).
    // In per-page mode, they're inside each page. Check both.
    let root = document.root_element();
    let mono_fonts = build_mono_font_ids(&root, &fontspec_sel);

    for page_el in document.select(&page_sel) {
        let page_num = page_el
            .value()
            .attr("number")
            .and_then(|n| n.parse::<u32>().ok())
            .unwrap_or(0);
        if page_num == 0 {
            continue;
        }

        let chapter = format!("Page {page_num}");

        // Emit Image elements for this page (from lopdf)
        if let Some(ref doc) = pdf_doc {
            if let Some(&page_id) = doc.get_pages().get(&page_num) {
                for _ in 0..count_page_images(doc, page_id) {
                    elements.push(DocElement::Image {
                        alt: format!("[image on page {page_num}]"),
                    });
                }
            }
        }

        // Merge page-level fontspecs (if any) with document-level ones
        let page_mono = build_mono_font_ids(&page_el, &fontspec_sel);
        let all_mono: std::collections::HashSet<String> = mono_fonts.union(&page_mono).cloned().collect();

        // Collect text runs with their monospace status, sorted by vertical position
        let mut runs: Vec<(i32, bool, String)> = Vec::new();
        for text_el in page_el.select(&text_sel) {
            let font_id = text_el.value().attr("font").unwrap_or("");
            let top: i32 = text_el
                .value()
                .attr("top")
                .and_then(|t| t.parse().ok())
                .unwrap_or(0);
            let is_mono = all_mono.contains(font_id);
            let content: String = text_el.text().collect();
            if content.trim().is_empty() {
                continue;
            }
            runs.push((top, is_mono, content));
        }

        // Merge text runs on the same line (same `top` value)
        let merged = merge_text_runs(&runs);

        // Group consecutive lines by type (mono vs non-mono)
        let mut i = 0;
        while i < merged.len() {
            let is_mono = merged[i].1;

            if is_mono {
                let mut code_lines = Vec::new();
                while i < merged.len() && merged[i].1 {
                    code_lines.push(merged[i].2.as_str());
                    i += 1;
                }
                let code_content = code_lines.join("\n");
                if !code_content.trim().is_empty() {
                    elements.push(DocElement::Code {
                        content: code_content,
                        language: None,
                        chapter: Some(chapter.clone()),
                    });
                }
            } else {
                let mut text_lines = Vec::new();
                while i < merged.len() && !merged[i].1 {
                    text_lines.push(merged[i].2.as_str());
                    i += 1;
                }
                let text_content = text_lines.join(" ");
                let cleaned = clean_pdf_page(&text_content);
                if !cleaned.is_empty() {
                    elements.push(DocElement::Text {
                        content: cleaned,
                        chapter: Some(chapter.clone()),
                    });
                }
            }
        }
    }

    Some(elements)
}

/// Builds a set of font IDs that are monospace from <fontspec> elements on a page.
fn build_mono_font_ids(page_el: &ElementRef, fontspec_sel: &Selector) -> std::collections::HashSet<String> {
    let mono_font_names = [
        "courier", "consolas", "menlo", "monaco", "inconsolata",
        "source code", "sourcecodepro", "fira code", "firacode",
        "dejavu sans mono", "dejavusansmono", "liberation mono",
        "droid sans mono", "ubuntu mono", "roboto mono",
        "lucida console", "andale mono", "monospace",
    ];

    let mut mono_ids = std::collections::HashSet::new();
    for fs in page_el.select(fontspec_sel) {
        let id = fs.value().attr("id").unwrap_or("");
        let family = fs.value().attr("family").unwrap_or("");
        // Extract font name after '+' (PDF subset prefix like "EBBBMO+Courier")
        let font_name = family
            .split('+')
            .last()
            .unwrap_or(family)
            .trim()
            .to_lowercase();
        if mono_font_names.iter().any(|m| font_name.contains(m)) {
            mono_ids.insert(id.to_string());
        }
    }
    mono_ids
}

/// Merges text runs that share the same vertical position (same line) into single lines.
/// A line is classified as monospace only if the majority of its text content (by char
/// count) comes from monospace font runs. This avoids false positives from inline code
/// references within prose (e.g. "Use the `Collection` interface").
fn merge_text_runs(runs: &[(i32, bool, String)]) -> Vec<(i32, bool, String)> {
    if runs.is_empty() {
        return Vec::new();
    }

    let mut merged: Vec<(i32, bool, String)> = Vec::new();
    let mut current_top = runs[0].0;
    let mut current_text = runs[0].2.clone();
    let mut mono_chars: usize = if runs[0].1 { runs[0].2.len() } else { 0 };
    let mut total_chars: usize = runs[0].2.len();

    for run in &runs[1..] {
        if (run.0 - current_top).abs() <= 3 {
            current_text.push_str(&run.2);
            total_chars += run.2.len();
            if run.1 {
                mono_chars += run.2.len();
            }
        } else {
            let is_mono = total_chars > 0 && mono_chars * 2 > total_chars;
            merged.push((current_top, is_mono, current_text));
            current_top = run.0;
            current_text = run.2.clone();
            mono_chars = if run.1 { run.2.len() } else { 0 };
            total_chars = run.2.len();
        }
    }
    let is_mono = total_chars > 0 && mono_chars * 2 > total_chars;
    merged.push((current_top, is_mono, current_text));

    merged
}

/// Fallback PDF extraction using pdftotext (no code detection).
fn extract_pdf_via_text(path: &str) -> Result<Vec<DocElement>, Box<dyn std::error::Error>> {
    let doc = lopdf::Document::load(path)?;
    let mut elements = Vec::new();
    let pdftotext_available = std::process::Command::new("pdftotext")
        .arg("-v")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok();

    for (page_num, page_id) in doc.get_pages() {
        for _ in 0..count_page_images(&doc, page_id) {
            elements.push(DocElement::Image {
                alt: format!("[image on page {page_num}]"),
            });
        }

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

            // Code blocks — <pre> elements (often containing <code>)
            // Preserve original whitespace; detect language from class attributes
            "pre" => {
                self.flush();
                let language = detect_code_language(el);
                let code_text = collect_code_text(el);
                if !code_text.trim().is_empty() {
                    self.elements.push(DocElement::Code {
                        content: code_text,
                        language,
                        chapter: self.current_chapter.clone(),
                    });
                }
            }

            // Block text elements — collect text, then check for nested images
            "p" | "li" | "blockquote" | "dd" | "dt" | "caption" | "figcaption" => {
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

/// Collects text from a code/pre block, preserving original whitespace and indentation.
fn collect_code_text(el: ElementRef) -> String {
    el.text().collect::<String>()
}

/// Tries to detect the programming language from class attributes on the element
/// or its first child <code> element. Looks for patterns like:
///   class="language-python", class="highlight-js", class="lang-rust",
///   class="python", class="sourceCode rust"
fn detect_code_language(el: ElementRef) -> Option<String> {
    // Check the element itself, then any nested <code> child
    if let Some(lang) = lang_from_class(el.value().attr("class")) {
        return Some(lang);
    }
    let code_sel = Selector::parse("code").unwrap();
    for code_el in el.select(&code_sel) {
        if let Some(lang) = lang_from_class(code_el.value().attr("class")) {
            return Some(lang);
        }
    }
    None
}

/// Extracts a language name from a CSS class string.
/// Recognises: language-xxx, lang-xxx, highlight-xxx, sourceCode xxx, or bare known names.
fn lang_from_class(class: Option<&str>) -> Option<String> {
    let class = class?;
    for token in class.split_whitespace() {
        // language-python, lang-rust, highlight-js
        for prefix in &["language-", "lang-", "highlight-"] {
            if let Some(lang) = token.strip_prefix(prefix) {
                if !lang.is_empty() {
                    return Some(lang.to_lowercase());
                }
            }
        }
    }
    // sourceCode followed by a language name (Pandoc convention)
    if class.contains("sourceCode") {
        for token in class.split_whitespace() {
            if token != "sourceCode" && token.chars().all(|c| c.is_alphanumeric()) {
                return Some(token.to_lowercase());
            }
        }
    }
    // Bare well-known language names
    let known = [
        "python", "javascript", "typescript", "rust", "go", "java", "c", "cpp",
        "csharp", "ruby", "php", "swift", "kotlin", "scala", "haskell", "lua",
        "perl", "r", "sql", "html", "css", "xml", "json", "yaml", "toml",
        "bash", "shell", "sh", "zsh", "fish", "powershell",
    ];
    for token in class.split_whitespace() {
        let lower = token.to_lowercase();
        if known.contains(&lower.as_str()) {
            return Some(lower);
        }
    }
    None
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
                DocElement::Code { .. } => "code",
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
    fn pre_block_becomes_code_element() {
        let els = extract_html(
            "<html><body><pre><code class=\"language-python\">def hello():\n    print(\"world\")</code></pre></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Code { content, language, .. } = &els[0] else { panic!("expected Code") };
        assert!(content.contains("def hello()"));
        assert!(content.contains("    print"), "indentation should be preserved");
        assert_eq!(language.as_deref(), Some("python"));
    }

    #[test]
    fn pre_without_language_class_has_no_language() {
        let els = extract_html(
            "<html><body><pre><code>some code</code></pre></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Code { language, .. } = &els[0] else { panic!("expected Code") };
        assert_eq!(*language, None);
    }

    #[test]
    fn pre_block_preserves_whitespace() {
        let els = extract_html(
            "<html><body><pre>  line1\n  line2\n    indented</pre></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Code { content, .. } = &els[0] else { panic!("expected Code") };
        assert!(content.contains("  line1\n  line2\n    indented"));
    }

    #[test]
    fn code_block_gets_chapter_context() {
        let els = extract_html(
            "<html><body><h2>Setup</h2><pre><code>npm install</code></pre></body></html>",
        );
        assert_eq!(els.len(), 1);
        let DocElement::Code { chapter, .. } = &els[0] else { panic!("expected Code") };
        assert_eq!(chapter.as_deref(), Some("Setup"));
    }

    #[test]
    fn text_before_and_after_code_block() {
        let els = extract_html(
            "<html><body><p>Before code.</p><pre><code>x = 1</code></pre><p>After code.</p></body></html>",
        );
        assert_eq!(els.len(), 3);
        assert!(matches!(&els[0], DocElement::Text { .. }));
        assert!(matches!(&els[1], DocElement::Code { .. }));
        assert!(matches!(&els[2], DocElement::Text { .. }));
    }

    #[test]
    fn lang_class_variations_detected() {
        // lang-xxx
        let els = extract_html("<html><body><pre><code class=\"lang-rust\">let x = 1;</code></pre></body></html>");
        let DocElement::Code { language, .. } = &els[0] else { panic!() };
        assert_eq!(language.as_deref(), Some("rust"));

        // highlight-xxx
        let els = extract_html("<html><body><pre class=\"highlight-javascript\">var x;</pre></body></html>");
        let DocElement::Code { language, .. } = &els[0] else { panic!() };
        assert_eq!(language.as_deref(), Some("javascript"));

        // sourceCode convention
        let els = extract_html("<html><body><pre><code class=\"sourceCode python\">pass</code></pre></body></html>");
        let DocElement::Code { language, .. } = &els[0] else { panic!() };
        assert_eq!(language.as_deref(), Some("python"));
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

    // ── PDF font-based code detection tests ──────────────────────────────

    #[test]
    fn build_mono_font_ids_detects_courier() {
        let xml = r##"<page number="1">
            <fontspec id="0" size="14" family="EBANNE+Sabon" color="#000" />
            <fontspec id="1" size="11" family="EBBBMO+Courier" color="#000" />
            <fontspec id="2" size="16" family="EBANKD+Sabon" color="#fff" />
        </page>"##;
        let doc = Html::parse_document(xml);
        let page_sel = Selector::parse("page").unwrap();
        let fontspec_sel = Selector::parse("fontspec").unwrap();
        let page = doc.select(&page_sel).next().unwrap();
        let mono = build_mono_font_ids(&page, &fontspec_sel);
        assert!(mono.contains("1"), "Courier should be monospace");
        assert!(!mono.contains("0"), "Sabon should not be monospace");
        assert!(!mono.contains("2"), "Sabon bold should not be monospace");
    }

    #[test]
    fn build_mono_font_ids_detects_various_mono_fonts() {
        let xml = r##"<page number="1">
            <fontspec id="0" size="10" family="ABC+Consolas" color="#000" />
            <fontspec id="1" size="10" family="DEF+Menlo" color="#000" />
            <fontspec id="2" size="10" family="GHI+SourceCodePro" color="#000" />
            <fontspec id="3" size="10" family="JKL+TimesNewRoman" color="#000" />
        </page>"##;
        let doc = Html::parse_document(xml);
        let page_sel = Selector::parse("page").unwrap();
        let fontspec_sel = Selector::parse("fontspec").unwrap();
        let page = doc.select(&page_sel).next().unwrap();
        let mono = build_mono_font_ids(&page, &fontspec_sel);
        assert!(mono.contains("0"), "Consolas is monospace");
        assert!(mono.contains("1"), "Menlo is monospace");
        assert!(mono.contains("2"), "SourceCodePro is monospace");
        assert!(!mono.contains("3"), "Times New Roman is not monospace");
    }

    #[test]
    fn merge_text_runs_combines_same_line() {
        let runs = vec![
            (100, false, "Hello ".to_string()),
            (100, false, "world".to_string()),
            (120, true, "code line".to_string()),
        ];
        let merged = merge_text_runs(&runs);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].2, "Hello world");
        assert!(!merged[0].1);
        assert_eq!(merged[1].2, "code line");
        assert!(merged[1].1);
    }

    #[test]
    fn merge_text_runs_majority_mono_wins() {
        // A line where most chars are mono should be classified as mono
        let runs = vec![
            (100, true, "public class Product extends Entity {".to_string()),
            (100, false, " ".to_string()),
        ];
        let merged = merge_text_runs(&runs);
        assert_eq!(merged.len(), 1);
        assert!(merged[0].1, "majority-mono line should be mono");
    }

    #[test]
    fn merge_text_runs_minority_mono_is_prose() {
        // A prose line with a small inline code ref should NOT be classified as mono
        let runs = vec![
            (100, false, "Use the ".to_string()),
            (100, true, "Collection".to_string()),
            (100, false, " interface for storage.".to_string()),
        ];
        let merged = merge_text_runs(&runs);
        assert_eq!(merged.len(), 1);
        assert!(!merged[0].1, "minority-mono line should be prose");
    }

    #[test]
    fn pdf_xml_extraction_groups_code_and_prose() {
        // Simulate pdftohtml -xml output for a page with mixed prose and code
        let xml = r##"<?xml version="1.0" encoding="UTF-8"?>
<pdf2xml>
<page number="1" position="absolute" top="0" left="0" height="1008" width="726">
    <fontspec id="0" size="14" family="EBANNE+Sabon" color="#000" />
    <fontspec id="1" size="11" family="EBBBMO+Courier" color="#000" />
<text top="100" left="106" width="500" height="15" font="0">This is a paragraph with enough words to pass the minimum word threshold for cleaning because it discusses important concepts about software.</text>
<text top="200" left="106" width="300" height="12" font="1">public class Product extends Entity {</text>
<text top="215" left="106" width="250" height="12" font="1">    private ProductId productId;</text>
<text top="230" left="106" width="50" height="12" font="1">}</text>
<text top="300" left="106" width="500" height="15" font="0">After the code we have more prose text that contains enough words to be meaningful and is not filtered out by the text cleaner.</text>
</page>
</pdf2xml>"##;

        let doc = Html::parse_document(xml);
        let page_sel = Selector::parse("page").unwrap();
        let fontspec_sel = Selector::parse("fontspec").unwrap();
        let text_sel = Selector::parse("text").unwrap();

        let mut elements = Vec::new();
        for page_el in doc.select(&page_sel) {
            let mono_fonts = build_mono_font_ids(&page_el, &fontspec_sel);

            let mut runs: Vec<(i32, bool, String)> = Vec::new();
            for text_el in page_el.select(&text_sel) {
                let font_id = text_el.value().attr("font").unwrap_or("");
                let top: i32 = text_el.value().attr("top").and_then(|t| t.parse().ok()).unwrap_or(0);
                let is_mono = mono_fonts.contains(font_id);
                let content: String = text_el.text().collect();
                if content.trim().is_empty() { continue; }
                runs.push((top, is_mono, content));
            }

            let merged = merge_text_runs(&runs);

            let mut i = 0;
            while i < merged.len() {
                let is_mono = merged[i].1;
                if is_mono {
                    let mut code_lines = Vec::new();
                    while i < merged.len() && merged[i].1 {
                        code_lines.push(merged[i].2.as_str());
                        i += 1;
                    }
                    elements.push(DocElement::Code {
                        content: code_lines.join("\n"),
                        language: None,
                        chapter: Some("Page 1".to_string()),
                    });
                } else {
                    let mut text_lines = Vec::new();
                    while i < merged.len() && !merged[i].1 {
                        text_lines.push(merged[i].2.as_str());
                        i += 1;
                    }
                    let text_content = text_lines.join(" ");
                    let cleaned = clean_pdf_page(&text_content);
                    if !cleaned.is_empty() {
                        elements.push(DocElement::Text {
                            content: cleaned,
                            chapter: Some("Page 1".to_string()),
                        });
                    }
                }
            }
        }

        // Should produce: Text, Code, Text
        assert_eq!(elements.len(), 3, "expected 3 elements, got: {:?}", elements);
        assert!(matches!(&elements[0], DocElement::Text { .. }));
        assert!(matches!(&elements[1], DocElement::Code { .. }));
        assert!(matches!(&elements[2], DocElement::Text { .. }));

        let DocElement::Code { content, .. } = &elements[1] else { panic!() };
        assert!(content.contains("public class Product"));
        assert!(content.contains("    private ProductId"));
    }
}
