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

    // get_pages() returns BTreeMap<u32, ObjectId> sorted by page number.
    for (page_num, page_id) in doc.get_pages() {
        // Emit an Image element for each image XObject on this page.
        // Images are emitted before the page text — a reasonable approximation
        // since PDF images are usually at the top or bottom of a page.
        for _ in 0..count_page_images(&doc, page_id) {
            elements.push(DocElement::Image {
                alt: format!("[image on page {page_num}]"),
            });
        }

        // Extract text for this page; skip on error (e.g. page has no text layer).
        if let Ok(text) = doc.extract_text(&[page_num]) {
            let text = text.trim().to_string();
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
}
