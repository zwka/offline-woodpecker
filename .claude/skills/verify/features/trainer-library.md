# Manage the Trainer library

Trainer keeps Puzzle Sets on the current browser origin and provides backup transfer, archiving, and permanent deletion from the library.

## Sub-features

- `library-backup-export` exports Puzzle Sets in a Trainer backup JSON document.
- `library-backup-restore` merges a backup into another clean Trainer origin.
- `library-archive` removes a Puzzle Set from the active library while retaining it as archived data.
- `library-delete` permanently removes a Puzzle Set after confirmation.

## How to get to it (user POV)

- Choose `Export backup` or `Restore backup` in `Your Puzzle Sets`.
- Choose `Archive` on a Puzzle Set to hide it from the active library.
- Choose `Delete set and history` and confirm to permanently remove a Puzzle Set and its Runs.

## Driving it with CDP helper

Preconditions:

- Node.js 22+, `npm ci`, Chrome, and `lsof` are available.
- Generator has at least one `Short` Puzzle and one `Mate In1` Puzzle in its default rating interval.
- The two Trainer origins are opened in one isolated Chrome profile; browser storage is separate by origin.

- **Export a backup.** Run `node .claude/skills/verify/scripts/drive.mjs trainer-library`. On the first Trainer origin, the helper chooses `Export backup` and verifies that the JSON includes `Warm-up tactics`.
- **Create backup content.** It generates and imports a separate set named `Verification Transfer`, exports another backup, and checks that the downloaded backup contains that set.
- **Restore on a second origin.** The helper opens a separately launched Trainer server, chooses `Restore backup`, and selects the downloaded backup file. The library and read-only IndexedDB check both show `Verification Transfer` on the second origin.
- **Archive.** It chooses `Archive Verification Transfer`. The set disappears from the active library while its IndexedDB record remains with `archived: true`.
- **Delete.** It imports a separate set named `Verification Delete`, chooses that set's `Delete set and history` action, accepts the app's confirmation dialog, and verifies the set no longer exists in IndexedDB.
- **Proof.** Inspect `00-trainer-library`, `20-trainer-restore-before`, `30-trainer-restore-after`, and `40-trainer-library-after` screenshots/state files, downloaded backups and Puzzle Sets, `actions.jsonl`, and `run-summary.json`.

## Gotchas

- Backup restore merges data. The second origin already seeds `Warm-up tactics`; the journey verifies that the unique imported Puzzle Set is added without replacing the existing set.
- This journey's backup contains Puzzle Sets but no Runs, so it does not prove Run-history transfer.
- Archive and delete have different persistence results. An archived record must remain in IndexedDB; a deleted record must be absent.
- Delete confirmation is destructive. The helper performs it only against its fresh temporary browser profile and the set created for this journey.
