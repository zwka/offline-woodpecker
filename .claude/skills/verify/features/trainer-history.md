# Inspect Run history

Trainer keeps completed Runs in local history and shows each Puzzle Result with the Run's first-try score.

## Sub-features

- `history-from-summary` opens results from a completed Run's `Inspect results` action.
- `history-navigation` opens the History view from primary navigation.
- `history-puzzle-result` shows the completed Run score and each Puzzle Result.

## How to get to it (user POV)

- Complete a Run and choose `Inspect results` from its summary.
- Or choose `History` in Trainer's primary navigation and select a Run.

## Driving it with CDP helper

Preconditions:

- Node.js 22+, `npm ci`, Chrome, and `lsof` are available.
- Generator has at least one `Mate In1` Puzzle in its default rating interval.
- Trainer uses a fresh isolated profile so the created Run is unambiguous.

- **Create a completed Run.** Run `node .claude/skills/verify/scripts/drive.mjs trainer-history`. The helper generates and imports a one-Puzzle set, starts a Run, and solves the Puzzle through the chessboard.
- **Open results from summary.** It chooses `Inspect results`. History shows the set name, `1/1 first-try score`, and a `First-try solve` Puzzle Result.
- **Open History from navigation.** It chooses the `History` button in `nav[aria-label="Primary navigation"]` and confirms the same completed result remains visible.
- **Confirm persistence.** The helper reads Trainer's IndexedDB in a read-only transaction and checks the stored Run is completed with a first-try Puzzle Result.
- **Proof.** Inspect `30-trainer-run-summary`, `40-trainer-history-detail`, and `50-trainer-history-navigation` screenshots/state files plus `actions.jsonl` and `run-summary.json`.

## Gotchas

- Run history is origin-local. A new browser profile intentionally begins with no Runs, so the helper creates the Run during the journey.
- The summary's score is based on first-try solves. Revealing a solution or making an incorrect move changes the Puzzle Result and score.
- History reached directly from navigation is checked after the summary entry point; both visible entry points are driven in the same invocation.
