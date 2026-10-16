import type { Puzzle, PuzzleSet, PuzzleSetSelection, SourceInfo } from "./schemas";

export async function computePuzzleSetHash(set: Pick<PuzzleSet, "selection" | "puzzles">): Promise<string> {
  const canonical = JSON.stringify({ selection: set.selection, puzzles: set.puzzles });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizePuzzleSet(set: PuzzleSet): Promise<PuzzleSet> {
  return {
    ...set,
    contentHash: await computePuzzleSetHash(set),
  };
}

export async function createPuzzleSet(input: {
  name: string;
  source: SourceInfo;
  selection: PuzzleSetSelection;
  puzzles: Puzzle[];
  createdAt?: string;
  id?: string;
}): Promise<PuzzleSet> {
  const draft: PuzzleSet = {
    kind: "puzzle-set",
    schemaVersion: 1,
    id: input.id ?? globalThis.crypto.randomUUID(),
    name: input.name.trim(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: input.source,
    selection: input.selection,
    contentHash: "0".repeat(64),
    puzzles: input.puzzles,
  };

  return normalizePuzzleSet(draft);
}
