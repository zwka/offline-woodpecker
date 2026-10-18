# Import a Puzzle Set

Trainer imports a self-contained Puzzle Set file into its local library so the player can start a Run without access to Generator's source index.

## Sub-features

- `trainer-import-set` imports a Generator JSON export through Trainer's library control.
- `trainer-import-persist` stores the imported Puzzle Set in the local Trainer database.
- `trainer-import-duplicate` reports duplicate Puzzle Sets instead of adding a second copy; this path is not exercised by the scripted journey.

## How to get to it (user POV)

- Open Trainer and choose `Import set` in `Your Puzzle Sets`.
- Select a Puzzle Set JSON previously exported from Generator.
- Confirm the imported set appears in the library and is ready to run.

## Driving it with CDP helper

Preconditions:

- Node.js 22+, `npm ci`, Chrome, and `lsof` are available.
- Generator has at least three `Short` puzzles in the default 1100-1600 rating interval.
- Trainer starts with an empty isolated profile and seeds `Warm-up tactics` from its checked-in demo file.

- **Launch and Doctor.** Run `node .claude/skills/verify/scripts/drive.mjs trainer-import`. The helper proves both app shells are usable and Trainer's demo library is visible.
- **Export source data.** In Generator, the helper enters `Verification import`, selects three `Short` puzzles, generates the preview, and downloads `downloads/export-01/verification-import.json` through `Export JSON`.
- **Import through Trainer.** It opens Trainer, captures the library before the action, chooses `Import set`, and selects the downloaded file in the browser file chooser.
- **Confirm persistence.** The library shows `Verification import` and the success notice. A read-only IndexedDB snapshot confirms the Puzzle Set is in the `puzzle-sets` store and is not archived.
- **Proof.** Inspect `20-trainer-before-import` and `30-trainer-after-import` PNG/state files, the exported JSON, `actions.jsonl`, and the recorded IndexedDB set count.

## Gotchas

- A fresh Trainer library is not blank after readiness: its demo Puzzle Set is seeded automatically. The helper verifies the imported set separately from `Warm-up tactics`.
- Import requires a valid exported Puzzle Set; a malformed file follows the app's error path and is not treated as a successful import.
- The duplicate-import notice is a separate behavior and is not covered by this journey.
