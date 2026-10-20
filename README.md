# Offline Woodpecker

## What this app does

Offline Woodpecker contains two Chrome apps for working with chess puzzles:

- **Generator** filters Lichess puzzles by rating and themes, then exports a Puzzle Set.
- **Trainer** imports Puzzle Sets, lets you solve them, and stores your Run history on the device.

After the apps and puzzle data are cached, they work offline. There is no account or remote API.

## Prerequisites

- Node.js 22 or newer, including npm, to install dependencies and build the apps.
- Chrome to use the apps; Android Chrome to install them on a phone.
- A static web host with HTTPS for a production deployment. HTTPS is required to install an app on Android.
- For the one-command Trainer Android preview: macOS or Linux, and `cloudflared` installed and available on `PATH`.
- For the full puzzle index only: the Lichess `.csv.zst` puzzle export and `zstd` installed. Without these, Generator uses the checked-in sample index.

## Development Setup

1. From the repository root, install dependencies:

   ```bash
   npm ci
   ```

2. Start either app in its own terminal:

   ```bash
   npm run dev:generator
   ```

   ```bash
   npm run dev:trainer
   ```

3. Open Generator at `http://127.0.0.1:4173` or Trainer at `http://127.0.0.1:4174`.

The checked-in sample index is enough to try Generator. To build the full local index, put the Lichess export at `puzzles-database/lichess_db_puzzle.csv.zst` and run this from the repository root. Replace `2026-10-05` with the date of that source dump:

```bash
npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
```

To install Trainer on an Android phone using a local preview, run this from the repository root on macOS or Linux:

```bash
./offline-woodpecker --install-trainer
```

Open the printed HTTPS URL in Android Chrome while the phone is online. Wait for Trainer's service worker to activate, then install it from Chrome's menu or add it to the home screen. The command installs dependencies, builds Trainer, starts its production preview, and opens a Cloudflare Quick Tunnel; it does not install the app on the phone. It runs `npm ci`, which recreates the workspace's root `node_modules`, so stop other workspace processes first. A repeated start reuses the URL if the session is healthy. If port `4174` is occupied, startup fails without stopping the existing listener.

Stop the preview and tunnel when finished:

```bash
./offline-woodpecker --shutdown-trainer
```

The tunnel URL is temporary and public to anyone who knows it. Session state and logs are stored under `.offline-woodpecker/`.

## Production Setup

1. From the repository root, install dependencies:

   ```bash
   npm ci
   ```

2. To include the full puzzle index, build it before building the apps. The source export and `zstd` are required for this step:

   ```bash
   npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
   ```

   Skip this step to release Generator with the checked-in sample index.

3. Build both apps:

   ```bash
   npm run build
   ```

4. Deploy `apps/generator/dist/` and `apps/trainer/dist/` to the root of two separate static HTTPS origins, for example `https://generator.example.com/` and `https://trainer.example.com/`. Each app must be at the root of its own origin; hosting them in subdirectories is not supported.

5. To install either deployed app on Android, open its HTTPS origin in Android Chrome while online. Wait for its service worker to activate, then install it from Chrome's menu or add it to the home screen. Keep Generator online until its full index has finished caching.

The static host does not need an API or application server. For a full-index release, deploy the generated manifest and compressed index together. When replacing the index at the same URLs, bump the Generator cache version in `apps/generator/public/sw.js` before building, then keep Generator online until its service worker has cached the new index.
