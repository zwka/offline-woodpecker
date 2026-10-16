import { puzzleSchema } from "./schemas";
import type { Puzzle, PuzzleSetSelection } from "./schemas";

export type SelectionProgress = {
  scanned: number;
  matches: number;
};

export type SelectionSuccess = {
  kind: "success";
  matches: number;
  puzzles: Puzzle[];
};

export type SelectionInsufficient = {
  kind: "insufficient";
  matches: number;
  requested: number;
};

export type SelectionResult = SelectionSuccess | SelectionInsufficient;

class SeededRandom {
  private state: number;

  public constructor(seed: string) {
    let hash = 2166136261;
    for (const character of seed) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    this.state = hash >>> 0;
  }

  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  public index(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

function matchesSelection(puzzle: Puzzle, selection: PuzzleSetSelection): boolean {
  if (puzzle.rating < selection.ratingMin || puzzle.rating > selection.ratingMax) {
    return false;
  }

  if (selection.themes.length === 0) {
    return true;
  }

  if (selection.themeMatch === "all") {
    return selection.themes.every((theme) => puzzle.themes.includes(theme));
  }

  return selection.themes.some((theme) => puzzle.themes.includes(theme));
}

function shuffleWithRandom<T>(items: T[], random: SeededRandom): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.index(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export async function selectPuzzlesFromStream(
  source: AsyncIterable<Puzzle>,
  selection: PuzzleSetSelection,
  onProgress?: (progress: SelectionProgress) => void,
): Promise<SelectionResult> {
  const random = new SeededRandom(selection.seed);
  const reservoir: Puzzle[] = [];
  let scanned = 0;
  let matches = 0;

  for await (const puzzle of source) {
    scanned += 1;
    if (!matchesSelection(puzzle, selection)) {
      if (scanned % 10000 === 0) {
        onProgress?.({ scanned, matches });
      }
      continue;
    }

    matches += 1;
    if (reservoir.length < selection.count) {
      reservoir.push(puzzle);
    } else {
      const replacementIndex = random.index(matches);
      if (replacementIndex < selection.count) {
        reservoir[replacementIndex] = puzzle;
      }
    }

    if (scanned % 10000 === 0) {
      onProgress?.({ scanned, matches });
    }
  }

  onProgress?.({ scanned, matches });
  if (matches < selection.count) {
    return { kind: "insufficient", matches, requested: selection.count };
  }

  return {
    kind: "success",
    matches,
    puzzles: shuffleWithRandom(reservoir, random),
  };
}

export async function* parsePuzzleJsonl(response: Response, compressed = false): AsyncGenerator<Puzzle> {
  if (!response.body) {
    const text = await response.text();
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        yield puzzleSchema.parse(JSON.parse(line));
      }
    }
    return;
  }

  const serverAlreadyDecompressed = response.headers.get("content-encoding")?.toLowerCase() === "gzip";
  const body = compressed && !serverAlreadyDecompressed
    ? response.body.pipeThrough(new DecompressionStream("gzip"))
    : response.body;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        yield puzzleSchema.parse(JSON.parse(line));
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    yield puzzleSchema.parse(JSON.parse(buffer));
  }
}

export function arrayAsPuzzleStream(puzzles: Puzzle[]): AsyncIterable<Puzzle> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* puzzles;
    },
  };
}
