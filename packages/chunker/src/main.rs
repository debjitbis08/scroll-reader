use std::io::{self, Read};
use chunker::{chunk, segment, ChunkOptions};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    text: String,
    options: Option<ChunkOptions>,
    /// When true, return raw segments instead of merged chunks.
    #[serde(default)]
    segment: bool,
}

fn main() {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).expect("failed to read stdin");

    let input: Input = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("chunker: invalid JSON input: {e}");
        std::process::exit(1);
    });

    let output = if input.segment {
        let segments = segment(&input.text);
        serde_json::to_string(&segments)
    } else {
        let options = input.options.unwrap_or_default();
        let chunks = chunk(&input.text, &options);
        serde_json::to_string(&chunks)
    };

    let json = output.unwrap_or_else(|e| {
        eprintln!("chunker: failed to serialize output: {e}");
        std::process::exit(1);
    });

    println!("{json}");
}
