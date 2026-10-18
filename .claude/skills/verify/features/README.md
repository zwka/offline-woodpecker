# Offline Woodpecker verification map

Read this index and the matching feature recipe before driving Generator or Trainer. The root-level map covers the two co-primary applications and their Puzzle Set handoff.

## Baseline preconditions

- Run from the repository root with Node.js 22+, `npm ci` completed, Chrome for desktop, and `lsof` available.
- Each `drive.mjs` feature command starts its own Generator and Trainer servers on reserved loopback ports and owns an isolated temporary Chrome profile.
- The helper exposes the checked-in 12-record sample through a temporary compressed generated-index fixture. It does not change or exercise the checkout's generated full index.
- A fresh Trainer origin seeds `Warm-up tactics` and persists sets and Runs in IndexedDB. Each verification invocation gets a new browser profile.
- There is no login, remote API, or server-side database.

## Driving conventions

- Invoke the feature command in its file from the repository root. The command performs Doctor before any feature action.
- The helper starts and drives only the instances it owns. Do not attach these journeys to a manually started server or a user's browser profile.
- Browser actions use visible button names, form IDs, the Trainer file chooser, and `data-square` chessboard handles.
- Use a fresh invocation for each feature so local browser state cannot leak between proofs.

## Proof and skip reporting

- Every journey records the user action and its resulting state in `actions.jsonl`, plus before/after UI snapshots and screenshots.
- Generator proof includes the actual downloaded Puzzle Set JSON. Trainer mutation proof includes a read-only IndexedDB snapshot.
- Evidence is retained under `.artifacts/verify-woodpecker/` in unique run and feature subdirectories after process and profile cleanup.
- Report an unmet seed-data precondition with the command output and feature ID. Do not mark a different journey as a substitute.
- Android installation is not covered by the browser journeys; use the Android tunnel instructions in `README.md` when that surface is the target.

## Features

- [Generate and export a Puzzle Set](./generate-export.md) covers filtering, preview, and the downloadable JSON handoff.
- [Import a Puzzle Set](./trainer-import.md) covers the Generator-to-Trainer file handoff and local persistence.
- [Solve a Puzzle and score a Run](./trainer-run.md) covers board moves, first-try scoring, and persisted Run completion.
- [Inspect Run history](./trainer-history.md) covers both history entry points and persisted Puzzle Results.
- [Manage the Trainer library](./trainer-library.md) covers backup export/restore, archive, and permanent deletion.
