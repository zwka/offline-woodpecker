# Offline Woodpecker

## 1. Description

- **Generator** filters the local Lichess puzzle index by rating and themes, then exports a self-contained Puzzle Set.
- **Trainer** imports Puzzle Sets, lets you solve them with first-try scoring, and stores Puzzle Sets and Run history locally.

Both apps are Chrome apps that work offline after their files and puzzle data are cached. They do not use an account or remote API.

## 2. Prerequisites

- Node.js 22 or newer, including npm, to install dependencies and build the apps.
- Chrome to use the apps; Android Chrome to install them on a phone.
- A static web host with HTTPS for a production deployment. HTTPS is required for Android installation.
- For the one-command Trainer Android preview: macOS or Linux, and `cloudflared` installed and available on `PATH`.
- To use the full Generator index: the Lichess `.csv.zst` puzzle export and `zstd`. Otherwise, Generator uses the checked-in sample index.

## 3. Development Setup

Run commands from the repository root. Install the workspace dependencies once:

```bash
npm ci
```

### Generator

1. To use the full local index, first put the Lichess export at `puzzles-database/lichess_db_puzzle.csv.zst` and run the following from the repository root. Replace the example date with the date of that source dump. Skip this step to use the checked-in sample index:

   ```bash
   npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
   ```

2. Start the development server:

   ```bash
   npm run dev:generator
   ```

3. Open `http://127.0.0.1:4173` in Chrome.

### Trainer

1. Start the development server:

   ```bash
   npm run dev:trainer
   ```

2. Open `http://127.0.0.1:4174` in Chrome.

To install Trainer on an Android phone from a local preview, run this on macOS or Linux:

```bash
./offline-woodpecker --install-trainer
```

Open the printed HTTPS URL in Android Chrome while online. Wait for the service worker to activate, then install Trainer from Chrome's menu or add it to the home screen. This command installs dependencies, builds Trainer, starts its production preview, and opens a Cloudflare Quick Tunnel; it does not install the app on the phone. It runs `npm ci`, which recreates the workspace's root `node_modules`, so stop other workspace processes first. A healthy repeat reuses the tunnel URL. The temporary URL is public to anyone who knows it.

Stop the preview and tunnel when finished:

```bash
./offline-woodpecker --shutdown-trainer
```

## 4. Production Setup

Run commands from the repository root. Install the workspace dependencies once:

```bash
npm ci
```

Deploy each app to the root of its own static HTTPS origin. The apps use root-relative paths, so hosting them under subdirectories is not supported. The static host does not need an API or application server.

### Generator

1. To include the full puzzle index, build it before the app. The Lichess export and `zstd` are required; replace the example date with the source dump date:

   ```bash
   npm run build:index -- --input puzzles-database/lichess_db_puzzle.csv.zst --snapshot 2026-10-05
   ```

   Skip this step to use the checked-in sample index.

2. Build Generator:

   ```bash
   npm --workspace @offline-woodpecker/generator run build
   ```

3. Deploy `apps/generator/dist/` to the root of its HTTPS origin. For a full-index build, deploy the generated manifest and compressed index together.

4. To install Generator on Android, open its HTTPS origin in Android Chrome while online. Wait for its service worker to activate and cache the app and puzzle index, then install it from Chrome's menu or add it to the home screen.

When publishing a new index at the same URLs, bump the cache version in `apps/generator/public/sw.js` before building. Keep Generator online until its service worker has cached the new index.

### Trainer

1. Build Trainer:

   ```bash
   npm --workspace @offline-woodpecker/trainer run build
   ```

2. Deploy `apps/trainer/dist/` to the root of its own HTTPS origin, separate from Generator's origin.

3. To install Trainer on Android, open its deployed HTTPS origin in Android Chrome while online. Wait for the service worker to activate, then install it from Chrome's menu or add it to the home screen.
