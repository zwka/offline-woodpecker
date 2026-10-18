# Solve a Puzzle and score a Run

Trainer starts a Run from an imported Puzzle Set, accepts moves on its chessboard, and records whether a Puzzle was solved on the first try.

## Sub-features

- `run-start` starts a Run from a Puzzle Set in the library.
- `run-board-move` accepts the expected move through the visible chessboard.
- `run-first-try` shows the completed Run score and persists its Puzzle Result.

## How to get to it (user POV)

- Import a Puzzle Set into Trainer's library.
- Choose `Start new Run` on that set.
- Play the displayed solution on the chessboard and read the completed Run summary.

## Driving it with CDP helper

Preconditions:

- Node.js 22+, `npm ci`, Chrome, and `lsof` are available.
- Generator's local index has at least one `Mate In1` Puzzle in its default rating range. The checked-in sample includes one.
- The generated Puzzle Set has a complete Mate In1 move line.

- **Prepare an importable set.** Run `node .claude/skills/verify/scripts/drive.mjs trainer-run`. The helper uses Generator's visible controls to create and download a one-Puzzle `Mate In1` set named `Verification Run`.
- **Import and start.** It selects that downloaded JSON through Trainer's `Import set` file picker, then chooses `Start new Run` on the matching library entry.
- **Solve on the board.** The helper reads the move line from the downloaded Puzzle Set and clicks `[data-square="d5"]`, then `[data-square="g2"]`, for the selected sample Puzzle. Both clicks pass through the chessboard UI.
- **Verify score and storage.** Trainer shows `Run complete` and `100%` first-try score. A read-only IndexedDB check confirms the Run is completed and its Puzzle Result is `first-try-solved`.
- **Proof.** Inspect `20-trainer-run-started` and `30-trainer-run-summary` PNG/state files, the downloaded Puzzle Set, `actions.jsonl`, and the IndexedDB result recorded in `run-summary.json`.

## Gotchas

- The helper reads the selected Puzzle's actual move line from the exported file, so the journey does not depend on a hard-coded Puzzle ID.
- `Mate In1` is displayed as the theme label. The helper's checked-in sample fixture has one matching Puzzle. A full generated index is not covered by this journey and must not be inferred from this proof.
- A legal but incorrect or illegal board move records a Failure and cannot earn a first-try point. This journey submits the selected Puzzle's expected user move.
