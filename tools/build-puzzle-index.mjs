import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { createGzip } from "node:zlib";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  const key = argument.slice(2);
  const value = process.argv[index + 1];
  if (value && !value.startsWith("--")) {
    args.set(key, value);
    index += 1;
  } else {
    args.set(key, "true");
  }
}

const inputPath = args.get("input");
if (!inputPath) {
  process.stderr.write("Usage: npm run build:index -- --input path/to/lichess_db_puzzle.csv.zst [--snapshot YYYY-MM-DD] [--output path]\n");
  process.exit(1);
}

const outputPath = resolve(args.get("output") ?? "apps/generator/public/puzzle-index.generated.jsonl.gz");
const manifestPath = resolve(args.get("manifest") ?? "apps/generator/public/puzzle-index.generated-manifest.json");
const snapshot = args.get("snapshot") ?? "2026-10-05";
if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot)) throw new Error(`Snapshot must use YYYY-MM-DD: ${snapshot}`);
const sourceInfo = {
  name: "Lichess Puzzle Database",
  url: "https://database.lichess.org/",
  snapshot,
  license: "CC0",
};

function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

function recordFromFields(fields) {
  if (fields.length !== 11) throw new Error(`Expected 11 CSV fields, got ${fields.length}`);
  const [id, fen, moves, rating, ratingDeviation, popularity, nbPlays, themes, gameUrl, openingTags, dailyDate] = fields;
  const integerField = (value, field, minimum, maximum = Number.POSITIVE_INFINITY) => {
    if (!/^-?\d+$/.test(value)) throw new Error(`Invalid ${field} for puzzle ${id}: ${value}`);
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`Invalid ${field} for puzzle ${id}: ${value}`);
    }
    return parsed;
  };
  const parsedMoves = moves.split(" ").filter(Boolean);
  const parsedThemes = themes.split(" ").filter(Boolean);
  if (id.length === 0 || fen.length === 0 || parsedMoves.length < 2 || parsedThemes.length === 0) {
    throw new Error(`Incomplete puzzle record: ${id}`);
  }
  if (!/^https?:\/\//.test(gameUrl)) throw new Error(`Invalid source URL for puzzle ${id}`);
  return {
    id,
    fen,
    moves: parsedMoves,
    rating: integerField(rating, "rating", 0),
    ratingDeviation: integerField(ratingDeviation, "rating deviation", 0),
    popularity: integerField(popularity, "popularity", -100, 100),
    nbPlays: integerField(nbPlays, "play count", 0),
    themes: parsedThemes,
    gameUrl,
    openingTags: openingTags.split(" ").filter(Boolean),
    dailyDate: dailyDate || null,
  };
}

async function writeLine(stream, value) {
  if (stream.write(`${JSON.stringify(value)}\n`)) return;
  await once(stream, "drain");
}

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(manifestPath), { recursive: true });
const temporaryOutputPath = `${outputPath}.tmp`;
const temporaryManifestPath = `${manifestPath}.tmp`;
const outputFile = createWriteStream(temporaryOutputPath);
const output = createGzip({ level: 9 });
output.pipe(outputFile);
const child = spawn("zstd", ["-dc", resolve(inputPath)], { stdio: ["ignore", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const childClosed = once(child, "close");
let childError = "";
child.stderr.on("data", (chunk) => {
  childError += chunk.toString();
});

const themes = new Set();
let recordCount = 0;
let ratingMin = Number.POSITIVE_INFINITY;
let ratingMax = Number.NEGATIVE_INFINITY;
let headerSeen = false;

try {
  for await (const line of lines) {
    if (!headerSeen) {
      headerSeen = true;
      continue;
    }
    if (line.trim().length === 0) continue;
    const record = recordFromFields(parseCsvLine(line));
    await writeLine(output, record);
    recordCount += 1;
    ratingMin = Math.min(ratingMin, record.rating);
    ratingMax = Math.max(ratingMax, record.rating);
    for (const theme of record.themes) themes.add(theme);
    if (recordCount % 100000 === 0) process.stderr.write(`Indexed ${recordCount.toLocaleString()} puzzles\n`);
  }
  output.end();
  await once(outputFile, "finish");
  const [exitCode] = await childClosed;
  if (exitCode !== 0) throw new Error(childError || `zstd exited with code ${exitCode}`);
  if (recordCount === 0) throw new Error("The input contained no puzzle records");

  const manifest = {
    kind: "puzzle-index-manifest",
    schemaVersion: 1,
    recordCount,
    ratingMin,
    ratingMax,
    themes: [...themes].sort(),
    source: sourceInfo,
  };
  const manifestStream = createWriteStream(temporaryManifestPath, { encoding: "utf8" });
  manifestStream.end(`${JSON.stringify(manifest, null, 2)}\n`);
  await once(manifestStream, "finish");
  await rename(temporaryOutputPath, outputPath);
  await rename(temporaryManifestPath, manifestPath);
  process.stderr.write(`Wrote ${recordCount.toLocaleString()} puzzles to ${outputPath}\n`);
} catch (error) {
  output.destroy();
  lines.close();
  child.kill();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
