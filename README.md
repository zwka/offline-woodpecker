# Offline Woodpecker

Offline Woodpecker is a pair of Chrome-based offline apps for creating and solving chess Puzzle Sets.

- **Generator**: filter the Lichess puzzle database by rating, themes, and count, then export a self-contained Puzzle Set.
- **Trainer**: import Puzzle Sets, solve them with first-try scoring, and keep persistent Run history locally.

The Trainer works in Chrome on desktop and Android Chrome. Android installation requires the production preview over HTTPS.

## Requirements

- Node.js 22 or newer
- Chrome for desktop development
- Android Chrome for mobile installation
- `zstd` when building the full puzzle index
- `cloudflared` when exposing the Trainer to an Android phone

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

## Build the full puzzle index

The checked-in sample index lets you exercise the UI without the full source database. Build the ignored, compressed index from the Lichess export when you need the complete dataset:

```bash
npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
```

Pass the snapshot date that belongs to any replacement source dump. The generated index is a gzip-compressed JSONL stream and is intentionally ignored by Git. Lichess puzzle exports are released under CC0; generated Puzzle Sets retain source metadata for traceability.

Keep the source `.zst` export in `puzzles-database/` locally. It is a build input and is not committed because the 293 MB file exceeds GitHub's regular-file limit.

## Open the Trainer on Android

Run the production build before opening the Trainer on your phone:

```bash
npm run build
npm --workspace @offline-woodpecker/trainer run preview
```

The preview server listens on `http://127.0.0.1:4174`. In a second terminal, start a Cloudflare Quick Tunnel to that exact URL:

```bash
cloudflared tunnel --url http://127.0.0.1:4174
```

Open the `https://<name>.trycloudflare.com` URL in Android Chrome. Wait for the library to load while online. The service worker caches the app shell during this first visit. Then install the Trainer from Chrome's menu or add it to the home screen.

After the first load, the service worker serves Trainer from the device cache. You can reopen it and solve locally stored Puzzle Sets without the preview server or tunnel. Trainer stores Puzzle Sets and Run history on the device.

To fetch updates or open Trainer on another device, start the preview and tunnel. Then visit the current tunnel URL. A restarted Quick Tunnel gets a new URL and creates a new app origin with separate browser storage. Export a Trainer backup before switching origins. Restore it at the new URL. If port `4174` is busy, choose another preview port and pass the same port to `cloudflared`:

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
