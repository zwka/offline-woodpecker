import { puzzleIndexManifestSchema } from "@offline-woodpecker/domain";
import type { PuzzleIndexManifest } from "@offline-woodpecker/domain";

export async function loadPuzzleIndex(fetcher: typeof fetch = fetch): Promise<{ manifest: PuzzleIndexManifest; index: string }> {
  const candidates = [
    { manifest: "/puzzle-index.generated-manifest.json", index: "/puzzle-index.generated.jsonl.gz" },
    { manifest: "/puzzle-index-manifest.json", index: "/puzzle-index.jsonl" },
  ];
  for (const candidate of candidates) {
    const response = await fetcher(candidate.manifest);
    if (!response.ok) continue;
    const indexResponse = await fetcher(candidate.index, { method: "HEAD" });
    if (indexResponse.ok) return { manifest: puzzleIndexManifestSchema.parse(await response.json()), index: candidate.index };
    if (candidate.manifest.includes("generated")) throw new Error("The full local index is not available offline yet. Open Generator online once to warm its cache.");
  }
  throw new Error("Puzzle index manifest could not be loaded");
}
