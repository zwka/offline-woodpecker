# Generate and export a Puzzle Set

Generator filters its local puzzle index and exports the selected puzzles as a self-contained Puzzle Set JSON file for Trainer.

## Sub-features

- `generator-filter` narrows local puzzles by rating and Tactic Theme.
- `generator-preview` reports the match count and shows the selected puzzle order.
- `generator-export` downloads the selected Puzzle Set as JSON.

## How to get to it (user POV)

- Open Generator at its local app origin.
- Enter a Set name, choose rating bounds and Tactic Themes, and set the puzzle count.
- Choose `Generate puzzle set`, inspect the preview, then choose `Export JSON`.

## Driving it with CDP helper

Preconditions:

- Node.js 22+, `npm ci`, Chrome, and `lsof` are available.
- The local Generator index has at least three `Short` puzzles between ratings 1100 and 1600. The checked-in sample index meets this precondition.

- **Launch and Doctor.** Run `node .claude/skills/verify/scripts/drive.mjs generator-export`. The helper starts isolated Generator and Trainer servers and confirms the rendered Generator has a loaded index and enabled Generate button.
- **Set filters.** The helper enters `Verification tactics` in `#set-name`, enters `3` in `#puzzle-count`, and leaves only the `Short` Tactic Theme selected. The displayed selection remains within the loaded manifest's 1100-1600 rating range.
- **Generate.** It chooses `Generate puzzle set`. The output preview shows the set name, three puzzles, a positive match count, rating range, seed, and ordered Puzzle rows.
- **Export.** It chooses `Export JSON`. The browser downloads `downloads/export-01/verification-tactics.json`; the helper checks `kind: puzzle-set`, the name, the three Puzzle records, and complete solution lines.
- **Proof.** Inspect the `verification-tactics-00-generator-ready`, `verification-tactics-10-generator-generated`, and `20-generator-exported` PNG/state files alongside `actions.jsonl` and the downloaded JSON in the printed evidence directory.

## Gotchas

- The helper redirects only Generator's temporary Vite `publicDir` to a scratch copy and exposes the checked-in sample under generated-index filenames. It does not modify or prove behavior on a multi-million-record full index.
- The match count is read from the rendered preview; the proof requires at least three matches, not a fixed total.
- Generator has no server-side or local database for generated sets. The downloaded JSON is the persistence side effect to verify.
- The first development load can reload when the service worker takes control. The helper waits for the usable UI and loaded index rather than relying on a fixed delay.
