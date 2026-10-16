import { z } from "zod";

export const sourceInfoSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  snapshot: z.string().min(1),
  license: z.string().min(1),
});

const uciMovePattern = /^[a-h][1-8][a-h][1-8][nbrq]?$/;

export const puzzleSchema = z.object({
  id: z.string().min(1),
  fen: z.string().min(1),
  moves: z.array(z.string().regex(uciMovePattern)).min(2),
  rating: z.number().int().nonnegative(),
  ratingDeviation: z.number().int().nonnegative(),
  popularity: z.number().int().min(-100).max(100),
  nbPlays: z.number().int().nonnegative(),
  themes: z.array(z.string().min(1)).min(1),
  gameUrl: z.string().url(),
  openingTags: z.array(z.string().min(1)),
  dailyDate: z.string().nullable(),
});

export const puzzleSetSelectionSchema = z.object({
  ratingMin: z.number().int().nonnegative(),
  ratingMax: z.number().int().nonnegative(),
  themes: z.array(z.string().min(1)),
  themeMatch: z.enum(["all", "any"]),
  count: z.number().int().positive(),
  seed: z.string().min(1),
}).refine((selection) => selection.ratingMin <= selection.ratingMax, {
  message: "ratingMin must be less than or equal to ratingMax",
  path: ["ratingMin"],
});

export const puzzleSetSchema = z.object({
  kind: z.literal("puzzle-set"),
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  source: sourceInfoSchema,
  selection: puzzleSetSelectionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  puzzles: z.array(puzzleSchema).min(1),
}).superRefine((set, context) => {
  if (set.selection.count !== set.puzzles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "selection.count must equal the number of puzzles", path: ["selection", "count"] });
  }
  if (new Set(set.puzzles.map((puzzle) => puzzle.id)).size !== set.puzzles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Puzzle IDs must be unique within a set", path: ["puzzles"] });
  }
});

export const puzzleIndexManifestSchema = z.object({
  kind: z.literal("puzzle-index-manifest"),
  schemaVersion: z.literal(1),
  recordCount: z.number().int().nonnegative(),
  ratingMin: z.number().int().nonnegative(),
  ratingMax: z.number().int().nonnegative(),
  themes: z.array(z.string().min(1)),
  source: sourceInfoSchema,
});

const puzzleResultBaseSchema = z.object({
  puzzleId: z.string().min(1),
  errorCount: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
});

export const puzzleResultSchema = z.discriminatedUnion("status", [
  puzzleResultBaseSchema.extend({
    status: z.literal("pending"),
  }),
  puzzleResultBaseSchema.extend({
    status: z.literal("first-try-solved"),
    completedAt: z.string().datetime(),
  }),
  puzzleResultBaseSchema.extend({
    status: z.literal("failed"),
    completion: z.enum(["pending", "completed", "skipped"]),
  }),
]);

const playingPuzzleStateSchema = z.object({
  kind: z.literal("playing"),
  moveIndex: z.number().int().min(1),
  retryCount: z.number().int().nonnegative(),
});

const errorPuzzleStateSchema = z.object({
  kind: z.literal("error"),
  moveIndex: z.number().int().min(1),
  retryCount: z.number().int().nonnegative(),
  reason: z.enum(["incorrect", "illegal"]),
});

const solutionRevealedPuzzleStateSchema = z.object({
  kind: z.literal("solution-revealed"),
  moveIndex: z.number().int().min(1),
  retryCount: z.number().int().nonnegative(),
});

const completedAfterErrorPuzzleStateSchema = z.object({
  kind: z.literal("completed-after-error"),
  retryCount: z.number().int().positive(),
});

const activePuzzleStateV1Schema = z.discriminatedUnion("kind", [
  playingPuzzleStateSchema,
  errorPuzzleStateSchema,
  completedAfterErrorPuzzleStateSchema,
]);

export const activePuzzleStateSchema = z.discriminatedUnion("kind", [
  playingPuzzleStateSchema,
  errorPuzzleStateSchema,
  solutionRevealedPuzzleStateSchema,
  completedAfterErrorPuzzleStateSchema,
]);

const runBaseSchema = z.object({
  kind: z.literal("run"),
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  setId: z.string().min(1),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  results: z.array(puzzleResultSchema).min(1),
});

const runBaseV1Schema = runBaseSchema.extend({ schemaVersion: z.literal(1) });

const currentRunSchema = z.union([
  runBaseSchema.extend({
    status: z.literal("active"),
    currentPuzzleIndex: z.number().int().nonnegative(),
    currentPuzzle: activePuzzleStateSchema,
  }),
  runBaseSchema.extend({
    status: z.enum(["completed", "abandoned"]),
    currentPuzzleIndex: z.null(),
    currentPuzzle: z.null(),
    endedAt: z.string().datetime(),
  }),
]);

const legacyRunSchema = z.union([
  runBaseV1Schema.extend({
    status: z.literal("active"),
    currentPuzzleIndex: z.number().int().nonnegative(),
    currentPuzzle: activePuzzleStateV1Schema,
  }),
  runBaseV1Schema.extend({
    status: z.enum(["completed", "abandoned"]),
    currentPuzzleIndex: z.null(),
    currentPuzzle: z.null(),
    endedAt: z.string().datetime(),
  }),
]);

export const runSchema = z.union([currentRunSchema, legacyRunSchema]).transform((run) => (
  run.schemaVersion === 2 ? run : currentRunSchema.parse({ ...run, schemaVersion: 2 })
));

const trainerBackupSetSchema = z.object({
  set: puzzleSetSchema,
  archived: z.boolean(),
});

export const trainerBackupSchema = z.object({
  kind: z.literal("trainer-backup"),
  schemaVersion: z.literal(2),
  exportedAt: z.string().datetime(),
  puzzleSets: z.array(trainerBackupSetSchema),
  runs: z.array(runSchema),
});

const legacyTrainerBackupSchema = z.object({
  kind: z.literal("trainer-backup"),
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  puzzleSets: z.array(puzzleSetSchema),
  runs: z.array(runSchema),
});

export type SourceInfo = z.infer<typeof sourceInfoSchema>;
export type Puzzle = z.infer<typeof puzzleSchema>;
export type PuzzleSetSelection = z.infer<typeof puzzleSetSelectionSchema>;
export type PuzzleSet = z.infer<typeof puzzleSetSchema>;
export type PuzzleIndexManifest = z.infer<typeof puzzleIndexManifestSchema>;
export type PuzzleResult = z.infer<typeof puzzleResultSchema>;
export type ActivePuzzleState = z.infer<typeof activePuzzleStateSchema>;
export type ActiveRun = Extract<z.infer<typeof runSchema>, { status: "active" }>;
export type TerminalRun = Extract<z.infer<typeof runSchema>, { status: "completed" | "abandoned" }>;
export type Run = z.infer<typeof runSchema>;
export type TrainerBackup = z.infer<typeof trainerBackupSchema>;

export function parsePuzzleSet(input: unknown): PuzzleSet {
  return puzzleSetSchema.parse(input);
}

export function parseRun(input: unknown): Run {
  return runSchema.parse(input);
}

export function parseTrainerBackup(input: unknown): TrainerBackup {
  const current = trainerBackupSchema.safeParse(input);
  if (current.success) return current.data;
  const legacy = legacyTrainerBackupSchema.parse(input);
  return {
    ...legacy,
    schemaVersion: 2,
    puzzleSets: legacy.puzzleSets.map((set) => ({ set, archived: false })),
  };
}
