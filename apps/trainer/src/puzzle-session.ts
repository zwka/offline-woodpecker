import { Chess, type PieceSymbol, type Square } from "chess.js";
import type { ActiveRun, ActivePuzzleState, Puzzle, PuzzleSet } from "@offline-woodpecker/domain";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const SQUARES = new Set(FILES.flatMap((file) => RANKS.map((rank) => `${file}${rank}`)));

export function isSquare(value: string): value is Square {
  return SQUARES.has(value);
}

function isPromotion(value: string): value is PieceSymbol {
  return value === "b" || value === "n" || value === "r" || value === "q";
}

function parseUci(value: string): { from: Square; to: Square; promotion?: PieceSymbol } | null {
  const fromValue = value.slice(0, 2);
  const toValue = value.slice(2, 4);
  if (!isSquare(fromValue) || !isSquare(toValue)) return null;
  const promotionValue = value.slice(4, 5);
  if (promotionValue.length === 0) return { from: fromValue, to: toValue };
  if (!isPromotion(promotionValue)) return null;
  return { from: fromValue, to: toValue, promotion: promotionValue };
}

function applyUci(game: Chess, uci: string): void {
  const move = parseUci(uci);
  if (!move) throw new Error(`Invalid UCI move: ${uci}`);
  game.move(move);
}

export function gameAtMoveIndex(puzzle: Puzzle, moveIndex: number): Chess {
  const game = new Chess(puzzle.fen);
  for (let index = 0; index < moveIndex; index += 1) {
    const move = puzzle.moves[index];
    if (!move) throw new Error(`Puzzle ${puzzle.id} is missing move ${index}`);
    applyUci(game, move);
  }
  return game;
}

export function validatePuzzleSet(set: PuzzleSet): void {
  for (const puzzle of set.puzzles) {
    try {
      const game = new Chess(puzzle.fen);
      if (puzzle.moves.length % 2 !== 0) throw new Error("the source move line must end on the player's move");
      for (const move of puzzle.moves) applyUci(game, move);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Puzzle ${puzzle.id} has an invalid chess line: ${reason}`);
    }
  }
}

export function puzzlePosition(puzzle: Puzzle, state: ActivePuzzleState): { fen: string; orientation: "white" | "black" } {
  const initialGame = gameAtMoveIndex(puzzle, 1);
  const finalMoveIndex = state.kind === "completed-after-error" ? puzzle.moves.length : state.moveIndex;
  return {
    fen: gameAtMoveIndex(puzzle, finalMoveIndex).fen(),
    orientation: initialGame.turn() === "w" ? "white" : "black",
  };
}

export type MoveAttempt =
  | { kind: "illegal" }
  | { kind: "incorrect" }
  | { kind: "continue"; moveIndex: number }
  | { kind: "complete" };

function sameUci(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function attemptMove(
  puzzle: Puzzle,
  run: ActiveRun,
  fromValue: string,
  toValue: string,
  promotion?: PieceSymbol,
): MoveAttempt {
  if (run.currentPuzzle.kind !== "playing") {
    return { kind: "illegal" };
  }

  const from = isSquare(fromValue) ? fromValue : null;
  const to = isSquare(toValue) ? toValue : null;
  if (!from || !to) return { kind: "illegal" };

  const expected = puzzle.moves[run.currentPuzzle.moveIndex];
  if (!expected) return { kind: "illegal" };

  const game = gameAtMoveIndex(puzzle, run.currentPuzzle.moveIndex);
  let move;
  try {
    move = game.move({ from, to, promotion });
  } catch {
    return { kind: "illegal" };
  }

  const actual = `${move.from}${move.to}${move.promotion ?? ""}`;
  // Lichess treats any legal checkmate as correct for a mate-in-one puzzle.
  const isMateInOne = puzzle.themes.includes("mateIn1") && game.isCheckmate();
  if (!isMateInOne && !sameUci(actual, expected)) {
    return { kind: "incorrect" };
  }

  if (isMateInOne || run.currentPuzzle.moveIndex + 1 >= puzzle.moves.length) {
    return { kind: "complete" };
  }

  const opponentMove = puzzle.moves[run.currentPuzzle.moveIndex + 1];
  if (!opponentMove) return { kind: "complete" };
  applyUci(game, opponentMove);
  return { kind: "continue", moveIndex: run.currentPuzzle.moveIndex + 2 };
}

export function promotionForDrop(piece: string, targetSquare: string): PieceSymbol | undefined {
  const isPawn = piece.slice(1, 2).toUpperCase() === "P";
  const lastRank = targetSquare.slice(1, 2);
  return isPawn && (lastRank === "1" || lastRank === "8") ? "q" : undefined;
}
