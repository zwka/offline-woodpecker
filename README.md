# Offline Woodpecker

Offline Woodpecker is a pair of Chrome-based offline apps for creating and solving chess Puzzle Sets.

- **Generator**: filter the Lichess puzzle database by rating, themes, and count, then export a self-contained Puzzle Set.
- **Trainer**: import Puzzle Sets, solve them with first-try scoring, and keep persistent Run history locally.

Both apps work in Chrome on desktop and Android Chrome. Mobile installation requires the production preview over HTTPS.

## Requirements

- Node.js 22 or newer
- Chrome for desktop development
- Android Chrome for mobile installation
- `zstd` when building the full puzzle index
- `cloudflared` when exposing either app to an Android phone

## Run the sample apps

Install the workspace dependencies:

```bash
npm install
```

Start the Generator with its checked-in sample index:

```bash
npm run dev:generator
```

Open `http://127.0.0.1:4173` in Chrome. Start the Trainer in a second terminal:

```bash
npm run dev:trainer
```

Open `http://127.0.0.1:4174` in Chrome. The development server is intended for desktop work. Use the production preview below when you need a service worker or Android installation.

## Run production previews

Build both apps:

```bash
npm run build
```

Start each production preview in a separate terminal:

```bash
npm --workspace @offline-woodpecker/generator run preview
```

```bash
npm --workspace @offline-woodpecker/trainer run preview
```

Open the Generator at `http://127.0.0.1:4173` and the Trainer at `http://127.0.0.1:4174`. These previews serve the production builds locally and enable the service workers used for offline operation.

## Build the full puzzle index

The checked-in sample index lets you exercise the UI without the full source database. Build the ignored, compressed index from the Lichess export when you need the complete dataset:

```bash
npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
```

Pass the snapshot date that belongs to any replacement source dump. The generated index is a gzip-compressed JSONL stream and is intentionally ignored by Git. Lichess puzzle exports are released under CC0; generated Puzzle Sets retain source metadata for traceability.

Keep the source `.zst` export in `puzzles-database/` locally. It is a build input and is not committed because the 293 MB file exceeds GitHub's regular-file limit.

## Install the apps on Android

Start both production previews as described above. Start a Cloudflare Quick Tunnel for each app in separate terminals:

```bash
cloudflared tunnel --url http://127.0.0.1:4173
```

```bash
cloudflared tunnel --url http://127.0.0.1:4174
```

Open each `https://<name>.trycloudflare.com` URL in Android Chrome while online. Wait for Generator to load its puzzle index and Trainer to load its library. Then install each app from Chrome's menu or add it to the home screen. The service workers cache each app shell; Generator also caches its puzzle index, while Trainer stores Puzzle Sets and Run history in browser storage.

After the first load, both apps can be reopened from their home-screen icons without the preview server or tunnel. Generator can create Puzzle Sets from its cached index; Trainer can solve locally stored Puzzle Sets and keeps Run history on the device.

To fetch updates or open either app on another device, start its preview and tunnel, then visit the current tunnel URL. A restarted Quick Tunnel gets a new URL and creates a new app origin with separate browser storage. Export a Trainer backup before switching origins and restore it at the new URL. If a preview port is busy, choose another port and pass the same port to `cloudflared`:

```bash
npm --workspace @offline-woodpecker/trainer run preview -- --port 4184
cloudflared tunnel --url http://127.0.0.1:4184
```

The Vite preview configuration allows `trycloudflare.com` hosts. The HTTPS origin provides the secure context required by service workers and Web Crypto on Android.

## Transfer and persistence

1. Generate a Puzzle Set in the Generator and export its JSON file.
2. Import the JSON file in the Trainer.
3. Use Trainer backup export to move Puzzle Sets and Run history to another device.

The Trainer stores sets, active Runs, completed Runs, and backup data in browser storage. It does not require an account or a remote API.

## Verify changes

```bash
npm run typecheck
npm test
npm run build
```

See [GLOSSARY.md](GLOSSARY.md) for domain terms, [docs/adr/](docs/adr/) for architecture decisions, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.
