# Self-contained Puzzle Set handoff

The Generator exports a versioned JSON Puzzle Set containing the complete puzzle data needed by the Trainer, rather than sharing the six-million-row source database or requiring a network connection. This makes imported sets portable, independently verifiable, and usable on Android Chrome without the Generator's source index.
