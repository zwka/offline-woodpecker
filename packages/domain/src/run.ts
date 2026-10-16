import type {
  ActiveRun,
  Puzzle,
  PuzzleResult,
  PuzzleSet,
  Run,
  TerminalRun,
} from "./schemas";

function nowIso(): string {
  return new Date().toISOString();
}

function runId(): string {
  return globalThis.crypto.randomUUID();
}

function pendingResult(puzzle: Puzzle): PuzzleResult {
  return {
    puzzleId: puzzle.id,
    status: "pending",
    errorCount: 0,
    retryCount: 0,
  };
}

function resultAt(run: ActiveRun, index: number): PuzzleResult {
  const result = run.results[index];
  if (!result) {
    throw new Error(`Run result ${index} is missing`);
  }
  return result;
}

function replaceResult(run: ActiveRun, index: number, result: PuzzleResult): PuzzleResult[] {
  return run.results.map((current, currentIndex) => (currentIndex === index ? result : current));
}

function advance(run: ActiveRun, timestamp: string): Run {
  const nextIndex = run.currentPuzzleIndex + 1;
  if (nextIndex >= run.results.length) {
    return {
      ...run,
      status: "completed",
      currentPuzzleIndex: null,
      currentPuzzle: null,
      endedAt: timestamp,
      updatedAt: timestamp,
    };
  }

  return {
    ...run,
    currentPuzzleIndex: nextIndex,
    currentPuzzle: {
      kind: "playing",
      moveIndex: 1,
      retryCount: 0,
    },
    updatedAt: timestamp,
  };
}

export function createRun(set: PuzzleSet, timestamp = nowIso()): ActiveRun {
  if (set.puzzles.length === 0) {
    throw new Error("Cannot create a Run for an empty Puzzle Set");
  }

  return {
    kind: "run",
    schemaVersion: 1,
    id: runId(),
    setId: set.id,
    status: "active",
    startedAt: timestamp,
    updatedAt: timestamp,
    currentPuzzleIndex: 0,
    currentPuzzle: {
      kind: "playing",
      moveIndex: 1,
      retryCount: 0,
    },
    results: set.puzzles.map(pendingResult),
  };
}

export function markPuzzleError(
  run: ActiveRun,
  reason: "incorrect" | "illegal",
  timestamp = nowIso(),
): ActiveRun {
  if (run.currentPuzzle.kind !== "playing") {
    throw new Error("An error can only be recorded while a Puzzle is playing");
  }

  const current = resultAt(run, run.currentPuzzleIndex);
  const nextResult: PuzzleResult = current.status === "failed"
    ? { ...current, errorCount: current.errorCount + 1 }
    : {
        puzzleId: current.puzzleId,
        status: "failed",
        completion: "pending",
        errorCount: current.errorCount + 1,
        retryCount: current.retryCount,
      };

  return {
    ...run,
    currentPuzzle: {
      kind: "error",
      moveIndex: run.currentPuzzle.moveIndex,
      retryCount: run.currentPuzzle.retryCount,
      reason,
    },
    results: replaceResult(run, run.currentPuzzleIndex, nextResult),
    updatedAt: timestamp,
  };
}

export function retryPuzzle(run: ActiveRun, timestamp = nowIso()): ActiveRun {
  if (run.currentPuzzle.kind !== "error") {
    throw new Error("Retry is only available after a Puzzle error");
  }

  const current = resultAt(run, run.currentPuzzleIndex);
  if (current.status !== "failed") {
    throw new Error("A retry requires a failed Puzzle Result");
  }

  const retryCount = run.currentPuzzle.retryCount + 1;
  const nextResult: PuzzleResult = {
    ...current,
    retryCount,
  };

  return {
    ...run,
    currentPuzzle: {
      kind: "playing",
      moveIndex: 1,
      retryCount,
    },
    results: replaceResult(run, run.currentPuzzleIndex, nextResult),
    updatedAt: timestamp,
  };
}

export function continuePuzzle(run: ActiveRun, moveIndex: number, timestamp = nowIso()): ActiveRun {
  if (run.currentPuzzle.kind !== "playing") {
    throw new Error("A Puzzle line can only continue while it is playing");
  }
  if (moveIndex <= run.currentPuzzle.moveIndex) {
    throw new Error("The next expected move must advance the Puzzle line");
  }

  return {
    ...run,
    currentPuzzle: {
      ...run.currentPuzzle,
      moveIndex,
    },
    updatedAt: timestamp,
  };
}

export function completePuzzle(run: ActiveRun, timestamp = nowIso()): Run {
  if (run.currentPuzzle.kind !== "playing") {
    throw new Error("A Puzzle can only complete while it is playing");
  }

  const current = resultAt(run, run.currentPuzzleIndex);
  if (current.status === "pending") {
    return advance(
      {
        ...run,
        results: replaceResult(run, run.currentPuzzleIndex, {
          puzzleId: current.puzzleId,
          status: "first-try-solved",
          errorCount: 0,
          retryCount: 0,
          completedAt: timestamp,
        }),
      },
      timestamp,
    );
  }

  if (current.status === "failed" && current.completion === "pending") {
    return {
      ...run,
      currentPuzzle: {
        kind: "completed-after-error",
        retryCount: current.retryCount,
      },
      results: replaceResult(run, run.currentPuzzleIndex, {
        ...current,
        completion: "completed",
      }),
      updatedAt: timestamp,
    };
  }

  throw new Error("This Puzzle Result cannot be completed again");
}

export function nextAfterPuzzle(run: ActiveRun, timestamp = nowIso()): Run {
  if (run.currentPuzzle.kind !== "error" && run.currentPuzzle.kind !== "completed-after-error") {
    throw new Error("Next is only available after a Puzzle error");
  }

  const current = resultAt(run, run.currentPuzzleIndex);
  const nextResult: PuzzleResult = current.status === "failed" && current.completion === "pending"
    ? { ...current, completion: "skipped" }
    : current;

  return advance(
    {
      ...run,
      results: replaceResult(run, run.currentPuzzleIndex, nextResult),
    },
    timestamp,
  );
}

export function abandonRun(run: ActiveRun, timestamp = nowIso()): TerminalRun {
  return {
    ...run,
    status: "abandoned",
    currentPuzzleIndex: null,
    currentPuzzle: null,
    endedAt: timestamp,
    updatedAt: timestamp,
  };
}

export type RunScore = {
  firstTrySolved: number;
  total: number;
  percentage: number;
  eventuallyCompleted: number;
  notCompleted: number;
};

export function scoreRun(run: Run): RunScore {
  const firstTrySolved = run.results.filter((result) => result.status === "first-try-solved").length;
  const eventuallyCompleted = run.results.filter(
    (result) => result.status === "failed" && result.completion === "completed",
  ).length;
  const notCompleted = run.results.filter(
    (result) => result.status === "failed" && result.completion === "skipped",
  ).length;
  const total = run.results.length;

  return {
    firstTrySolved,
    total,
    percentage: total === 0 ? 0 : Math.round((firstTrySolved / total) * 100),
    eventuallyCompleted,
    notCompleted,
  };
}
