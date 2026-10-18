---
name: verify
description: Verify Offline Woodpecker's Generator and Trainer browser apps through isolated user journeys for Puzzle Set export and import, Runs, Run history, and Trainer library data.
---

# Verify Offline Woodpecker

Use the feature map in `.claude/skills/verify/features/README.md` before driving a user journey. Generator and Trainer are separate offline browser apps in one workspace; the verification helper drives both where a journey crosses the handoff.

## Launch

Run one feature journey from the repository root:

```bash
node .claude/skills/verify/scripts/drive.mjs generator-export
node .claude/skills/verify/scripts/drive.mjs trainer-import
node .claude/skills/verify/scripts/drive.mjs trainer-run
node .claude/skills/verify/scripts/drive.mjs trainer-history
node .claude/skills/verify/scripts/drive.mjs trainer-library
```

Each invocation starts the required Vite development servers on dynamically reserved loopback ports and opens headless Chrome with a fresh temporary profile. It completes the launch, Doctor, drive, evidence, and cleanup phases in that order. Requirements are Node.js 22+, dependencies installed with `npm ci`, Chrome for desktop, and `lsof` for the port-ownership check. Set `CHROME_BIN` when Chrome is not at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

The empty profile is usable without manual setup. To keep journeys quick and deterministic even when the checkout has a multi-million-record local index, the helper copies Generator's checked-in public assets into a temporary directory and exposes the 12-record sample as a compressed generated-index fixture. It launches the real Generator source and its real Vite config with only `publicDir` redirected; existing generated index files are not changed. This proves the generated-index loading and filtering path with sample data, not performance or selection results on the full index. Trainer creates its IndexedDB stores on first use and imports `Warm-up tactics` from `apps/trainer/public/demo-set.json` when the library is empty. There are no credentials, remote APIs, database servers, or other seed commands. The helper waits for Generator's loaded index and enabled Generate button, and for Trainer's seeded library, before declaring readiness.

The two apps are the primary user surfaces. Android Chrome installation and offline reloads are secondary PWA checks; use the documented tunnel setup in `README.md` for a phone and `npm run check:pwa` for the scripted desktop/mobile-emulation installability check.

## Doctor

The helper runs this read-only check before each journey and writes its result to `doctor.json` in the evidence directory. It checks that each launched process is alive, `lsof` identifies that exact process as the listener on its port, the workspace version is `0.1.0`, the served HTML has the app root, and the rendered UI is the expected usable Generator or Trainer surface. Trainer readiness includes the seeded Puzzle Set, not only an HTTP response. Authentication is not applicable because both apps are local browser applications without accounts.

When startup or a journey looks wrong, rerun the same feature command to get a fresh Doctor result and inspect the retained `doctor.json`, server logs, and action trace. Each command owns the processes and browser profile it drives; it never attaches to an already-running development server.

## Drive

The browser driver is `.claude/skills/verify/scripts/drive.mjs`. It uses Chrome DevTools Protocol through Node.js WebSocket, resolves controls by visible names or stable selectors, and performs real browser clicks, text entry, downloads, file selection, and chessboard square clicks. It waits for downloaded JSON to parse before recording the file. The board squares use `data-square` handles from `react-chessboard`.

Read the matching feature file for preconditions and proof criteria:

- `generator-export`: set name, rating/theme selection, puzzle count, Generate puzzle set, and Export JSON.
- `trainer-import`: Generator export followed by Trainer's Import set file picker.
- `trainer-run`: import a one-puzzle Mate In1 set, start a Run, and solve it on the board.
- `trainer-history`: complete a Run, inspect its results from the summary, and open History from primary navigation.
- `trainer-library`: export and restore a Trainer backup, archive a Puzzle Set, and delete a separate Puzzle Set with confirmation.

## Evidence

Artifacts are written under `.artifacts/verify-woodpecker/`, with a unique run directory and feature subdirectory. Every journey captures page-state JSON and PNG screenshots before and after its main action, an `actions.jsonl` trace with each action and observed result, a Doctor report, server logs, and any downloaded JSON. Trainer journeys also read IndexedDB through a read-only transaction and record the persisted Puzzle Set or Run state.

Proof exercises the user-facing path. The helper downloads Generator output from Export JSON and imports it through Trainer's visible file picker; it does not call app setters or test-only endpoints. It checks the downloaded document and the Trainer library or Run records as well as the rendered UI. Neither app has an external integration boundary to mock. No journey uses a dry-run mode.

If a journey fails, its command exits nonzero and retains all evidence captured up to the failure. Do not claim another feature path as proof for the failed one. `run-summary.json` records the outcome and evidence path.

## Cleanup

Cleanup runs in `finally` on both passing and failing journeys. `SIGINT` and `SIGTERM` close the DevTools connection and unwind through the same cleanup path. The helper stops only the Chrome and Vite child processes it spawned, then removes the temporary Chrome profile containing its IndexedDB, local storage, and service-worker cache, plus the temporary Generator public fixture. It never removes `.artifacts/verify-woodpecker/`; `cleanup.json` records stopped process IDs and confirms scratch state was removed while the evidence directory remained.

Do not kill processes by name or drive an instance not owned by this invocation. Dynamic ports, separate profiles, and run-specific artifact directories allow independent invocations to run side by side. A busy user port is not reused.

## Helpers

The executable helper and all supported invocations are listed under Launch. Its feature IDs are `generator-export`, `trainer-import`, `trainer-run`, `trainer-history`, and `trainer-library`; it always performs cleanup, including after a failed iteration.
