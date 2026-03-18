use std::io::{self, Read};
use chunker::{chunk, ChunkOptions};
use serde::Deserialize;

#[derive(Deserialize)]
struct Input {
    text: String,
    options: Option<ChunkOptions>,
}

fn main() {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).expect("failed to read stdin");

    let input: Input = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("chunker: invalid JSON input: {e}");
        std::process::exit(1);
    });

    let options = input.options.unwrap_or_default();
    let chunks = chunk(&input.text, &options);

    let output = serde_json::to_string(&chunks).unwrap_or_else(|e| {
        eprintln!("chunker: failed to serialize output: {e}");
        std::process::exit(1);
    });

    println!("{output}");
}
