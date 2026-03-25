use std::io::{self, Read};
use std::path::Path;
use extractor::{extract_epub_with_images, extract_pdf_with_images};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    file_path: String,
    /// Optional directory for extracted images. When provided, images are
    /// written to disk and their paths emitted in the JSON output.
    #[serde(default)]
    output_dir: Option<String>,
}

fn main() {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).expect("failed to read stdin");

    let input: Input = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("extractor: invalid JSON input: {e}");
        std::process::exit(1);
    });

    let path = &input.file_path;
    let output_dir = input.output_dir.as_deref().map(Path::new);

    let result = if path.ends_with(".epub") {
        extract_epub_with_images(path, output_dir)
    } else if path.ends_with(".pdf") {
        extract_pdf_with_images(path, output_dir)
    } else {
        eprintln!("extractor: unsupported file type: {path}");
        std::process::exit(1);
    };

    let elements = result.unwrap_or_else(|e| {
        eprintln!("extractor: failed to extract {path}: {e}");
        std::process::exit(1);
    });

    let output = serde_json::to_string(&elements).unwrap_or_else(|e| {
        eprintln!("extractor: failed to serialize output: {e}");
        std::process::exit(1);
    });

    println!("{output}");
}
