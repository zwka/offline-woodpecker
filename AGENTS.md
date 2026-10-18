## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `zwka/offline-woodpecker`, using `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context root `GLOSSARY.md` and `docs/adr/` layout. See `docs/agents/domain.md`.

### Project entry points

- Read `README.md` when changing local development, full-index generation, production preview, or Android tunnel setup.
- Read `.claude/skills/verify/SKILL.md` before running Generator or Trainer browser workflows; it lists the journeys and evidence they produce.
- Read `GLOSSARY.md` before naming Puzzle Sets, Runs, Puzzle Results, or scoring states.
- Read the relevant file in `docs/adr/` before changing the browser-first runtime, Puzzle Set handoff, or source-index boundary.
- Read `THIRD_PARTY_NOTICES.md` before changing chessboard artwork or source-data attribution.
