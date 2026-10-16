# Build-time puzzle index

The compressed Lichess CSV is converted during the release/build process into a gzip-compressed JSONL index suitable for local streaming filters. The Generator does not decompress or parse the roughly 1 GiB source on every launch; the original `.zst` remains build input and the generated index remains an ignored release artifact.
