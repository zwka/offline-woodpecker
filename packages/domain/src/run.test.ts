import { describe, expect, it } from "vitest";
import {
  completePuzzle,
  createRun,
  markPuzzleError,
  nextAfterPuzzle,
  retryPuzzle,
  scoreRun,
} from "./run";
import type { PuzzleSet } from "./schemas";

const set: PuzzleSet = {
  kind: "puzzle-set",
  schemaVersion: 1,
  id: "set-1",
  name: "Test set",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: {
    name: "Lichess",
    url: "https://database.lichess.org/",
    snapshot: "2026-10-05",
    license: "CC0",
  },
  selection: {
    ratingMin: 800,
    ratingMax: 1400,
    themes: [],
    themeMatch: "all",
    count: 2,
    seed: "test",
  },
  contentHash: "0".repeat(64),
  puzzles: [
    {
      id: "p-1",
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      moves: ["a1a2", "h1h2"],
      rating: 1000,
      ratingDeviation: 80,
      popularity: 80,
      nbPlays: 10,
      themes: ["short"],
      gameUrl: "https://lichess.org/test1",
      openingTags: [],
      dailyDate: null,
    },
    {
      id: "p-2",
      fen: "8/8/8/8/8/8/K6k/8 w - - 0 1",
      moves: ["a2a3", "h2h3"],
      rating: 1000,
      ratingDeviation: 80,
      popularity: 80,
      nbPlays: 10,
      themes: ["short"],
      gameUrl: "https://lichess.org/test2",
      openingTags: [],
      dailyDate: null,
    },
  ],
};

describe("Run state", () => {
  it("scores a clean solution and advances automatically", () => {
    const run = createRun(set, "2026-01-01T00:00:00.000Z");
    const afterFirst = completePuzzle(run, "2026-01-01T00:01:00.000Z");

    expect(afterFirst.status).toBe("active");
    if (afterFirst.status === "active") {
      expect(afterFirst.currentPuzzleIndex).toBe(1);
      expect(scoreRun(afterFirst).firstTrySolved).toBe(1);
    }
  });

  it("keeps a failed puzzle visible until next is selected", () => {
    const run = createRun(set);
    const errored = markPuzzleError(run, "incorrect");
    const retried = retryPuzzle(errored);
    const completed = completePuzzle(retried);

    expect(completed.status).toBe("active");
    if (completed.status === "active") {
      expect(completed.currentPuzzle.kind).toBe("completed-after-error");
      expect(scoreRun(completed)).toMatchObject({
        firstTrySolved: 0,
        eventuallyCompleted: 1,
        notCompleted: 0,
      });

      const next = nextAfterPuzzle(completed);
      expect(next.status).toBe("active");
      if (next.status === "active") {
        expect(next.currentPuzzleIndex).toBe(1);
      }
    }
  });
});
