# Offline Woodpecker

Offline Woodpecker is a pair of Chrome-based offline apps for creating and solving chess Puzzle Sets.

- **Generator**: filter the Lichess puzzle database by rating, themes, and count, then export a self-contained Puzzle Set.
- **Trainer**: import Puzzle Sets, solve them with first-try scoring, and keep persistent Run history locally.

Both apps work in Chrome on desktop and Android Chrome. Mobile installation requires a secure HTTPS origin.

## Requirements

- Node.js 22 or newer
- Chrome for desktop development
- Android Chrome for mobile installation
- `zstd` when building the full puzzle index
- `cloudflared` when exposing either app to an Android phone

## Development setup

Install the workspace dependencies from the repository root:

```bash
npm ci
```

Start the Generator and Trainer in separate terminals:

```bash
npm run dev:generator
```

```bash
npm run dev:trainer
```

Open `http://127.0.0.1:4173` for Generator and `http://127.0.0.1:4174` for Trainer. A fresh checkout uses the small checked-in sample index. If the generated full index exists in `apps/generator/public/`, Generator uses it instead.

Both development servers register a service worker. On first load, the development page reloads after the worker takes control. Loopback HTTP origins are secure contexts in Chrome, so they can be used to verify offline behavior on the development machine. Android installation requires HTTPS; use the tunnel procedure below.

## Build the full puzzle index

The checked-in sample index exercises the UI without the source database. To build the full local index, keep the Lichess `.csv.zst` export in `puzzles-database/` and run:

```bash
npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
```

Pass the snapshot date for the source dump being built. The command requires `zstd` and writes `puzzle-index.generated.jsonl.gz` and `puzzle-index.generated-manifest.json` into `apps/generator/public/`. These generated files and the source `.zst` are ignored by Git; build them on the machine or CI job that creates the production bundle. The source export is about 293 MB and exceeds GitHub's regular-file limit. Lichess puzzle exports are CC0; generated Puzzle Sets include source metadata for traceability.

## How the apps work

Generator reads the local index manifest for available ratings and themes, then streams the compressed JSONL records to filter by rating and themes. A seed makes the selected Puzzle Set order reproducible. The exported versioned JSON contains the puzzles and metadata Trainer needs, so Trainer does not need the source index or a network connection.

Trainer validates imported Puzzle Sets and runs them locally. It stores Puzzle Sets and Runs in IndexedDB; theme preferences use local storage. Neither app has a remote API or account service. Service workers cache each app shell, and Generator also caches the generated full index when it is present. Browser caches and Trainer data belong to the app's origin.

The generated index is large. Keep Generator online until its service-worker installation or update has completed before relying on the full index offline. In Chrome DevTools, check **Application > Service Workers** for an active worker and **Application > Cache Storage** for `puzzle-index.generated.jsonl.gz`. If no generated index was built, the sample index is the only puzzle data available offline.

## Build and deploy

For a full-data release, build the index before building the apps. Omit the `build:index` command when a sample-data build is intended:

```bash
npm ci
npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
npm run build
```

`npm run build` type-checks and builds both apps. The static output directories are `apps/generator/dist/` and `apps/trainer/dist/`. Deploy each directory to the root of its own static HTTPS origin, for example `https://generator.example.com/` and `https://trainer.example.com/`. The apps use root-relative asset paths and each registers `/sw.js`, so hosting them under separate subdirectories of the same origin is not supported by the current configuration.

The generated index files must exist before the build so Vite copies them into `apps/generator/dist/`. Deploy the generated manifest and compressed index together. For a new index snapshot at the same URLs, bump the Generator cache version in `apps/generator/public/sw.js` before building; this makes existing installs create a fresh cache and download the new index. Keep Generator online until that service-worker installation finishes. The deployed host only needs to serve static files; the apps do not require a server-side API.

Before deployment, production previews can be run locally in separate terminals:

```bash
npm --workspace @offline-woodpecker/generator run preview
```

```bash
npm --workspace @offline-woodpecker/trainer run preview
```

These previews serve the production bundles at `http://127.0.0.1:4173` and `http://127.0.0.1:4174`. They are for local verification, not a deployment server. Chrome installability and offline reloads can be checked with `npm run check:pwa`.

## Install on Android

For a production deployment, open each app's HTTPS origin in Android Chrome while online, wait for its service worker to activate, then install it from Chrome's menu or add it to the home screen.

To test a local production build on Android, start both production previews as described above. Start a Cloudflare Quick Tunnel for each app in separate terminals:

```bash
cloudflared tunnel --url http://127.0.0.1:4173
```

```bash
cloudflared tunnel --url http://127.0.0.1:4174
```

Open each `https://<name>.trycloudflare.com` URL in Android Chrome while online. Wait for Generator's service worker to finish caching the index and for Trainer to load its library, then install each app. The HTTPS tunnel provides the secure origin required for service workers and Web Crypto on Android.

After installation and caching complete, both apps can be reopened from their home-screen icons without the preview server or tunnel. Generator can create Puzzle Sets from its cached index; Trainer can solve locally stored Puzzle Sets and keeps Run history on the device.

To fetch updates, revisit the same HTTPS URL. If a Quick Tunnel restarts, its URL changes and creates a new origin with separate browser caches and Trainer data. Export a Trainer backup before switching origins and restore it at the new URL. If a preview port is busy, choose another port and pass the same port to `cloudflared`:

```bash
npm --workspace @offline-woodpecker/trainer run preview -- --port 4184
cloudflared tunnel --url http://127.0.0.1:4184
```

The Vite preview configuration allows `trycloudflare.com` hosts.

## Transfer and persistence

1. Generate a Puzzle Set in the Generator and export its JSON file.
2. Import the JSON file in the Trainer.
3. Use Trainer backup export to move Puzzle Sets and Run history to another device.

Trainer backup export moves Puzzle Sets and Run history between origins or devices. The backup does not transfer Generator's source index; that index is cached separately by Generator.

## Verify changes

```bash
npm run typecheck
npm test
npm run build
```

Check Chrome installability and offline reloads in desktop and Android-style mobile contexts:

```bash
npm run check:pwa
```

This check requires Chrome and uses loopback origins, which Chrome treats as secure contexts. Installing on an Android phone still requires HTTPS.

See [GLOSSARY.md](GLOSSARY.md) for domain terms, [docs/adr/](docs/adr/) for architecture decisions, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.
