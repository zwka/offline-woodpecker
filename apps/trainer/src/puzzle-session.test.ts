import { describe, expect, it } from "vitest";
import { continuePuzzle, createRun, type Puzzle, type PuzzleSet } from "@offline-woodpecker/domain";
import { attemptMove, gameAtMoveIndex, promotionForDrop, puzzlePosition } from "./puzzle-session";

const puzzle: Puzzle = {
  id: "0000H",
  fen: "r4rk1/pp3ppp/8/2bqp2b/3N4/P2Bn2P/1PPN1P2/R1BQ1RK1 w - - 1 15",
  moves: ["d1h5", "d5g2"],
  rating: 1554,
  ratingDeviation: 223,
  popularity: 100,
  nbPlays: 11,
  themes: ["mate", "mateIn1", "middlegame", "oneMove"],
  gameUrl: "https://lichess.org/EwHRkfas#29",
  openingTags: [],
  dailyDate: null,
};

const set: PuzzleSet = {
  kind: "puzzle-set",
  schemaVersion: 1,
  id: "test-set",
  name: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: {
    name: "Lichess Puzzle Database",
    url: "https://database.lichess.org/",
    snapshot: "2026-10-05",
    license: "CC0",
  },
  selection: {
    ratingMin: 1000,
    ratingMax: 1800,
    themes: [],
    themeMatch: "all",
    count: 1,
    seed: "test",
  },
  contentHash: "0".repeat(64),
  puzzles: [puzzle],
};

describe("puzzle session", () => {
  it("applies the automatic setup move and accepts the mate-in-one solution", () => {
    const position = puzzlePosition(puzzle, { kind: "playing", moveIndex: 1, retryCount: 0 });
    expect(position.orientation).toBe("black");
    expect(() => gameAtMoveIndex(puzzle, 1)).not.toThrow();

    const run = createRun(set);
    expect(attemptMove(puzzle, run, "d5", "g2")).toEqual({ kind: "complete" });
  });

  it("rejects an incorrect legal attempt without changing the expected line", () => {
    const run = createRun(set);
    const result = attemptMove(puzzle, run, "d5", "d4");
    expect(["incorrect", "illegal"]).toContain(result.kind);
  });

  it("keeps under-promotion choices available instead of forcing a queen", () => {
    const underPromotion: Puzzle = {
      id: "03kqY",
      fen: "8/2Q2ppk/4b2p/8/4P3/2p3P1/4KP1P/2r5 w - - 4 49",
      moves: ["f2f4", "e6b3", "e4e5", "c3c2", "e5e6", "f7e6", "c7c3", "c1d1", "c3b3", "c2c1n", "e2d1", "c1b3"],
      rating: 1900,
      ratingDeviation: 80,
      popularity: 90,
      nbPlays: 20,
      themes: ["underPromotion", "veryLong"],
      gameUrl: "https://lichess.org/under-promotion",
      openingTags: [],
      dailyDate: null,
    };
    let run = createRun({ ...set, puzzles: [underPromotion], selection: { ...set.selection, count: 1 } });
    const line = [
      ["e6", "b3"],
      ["c3", "c2"],
      ["f7", "e6"],
      ["c1", "d1"],
      ["c2", "c1"],
    ];
    for (const [from, to] of line.slice(0, 4)) {
      const result = attemptMove(underPromotion, run, from, to);
      expect(result.kind).toBe("continue");
      if (result.kind === "continue") run = continuePuzzle(run, result.moveIndex);
    }
    expect(promotionForDrop("bP", "c1")).toBe("q");
    expect(attemptMove(underPromotion, run, "c2", "c1", "n")).toEqual({ kind: "continue", moveIndex: 11 });
  });
});
