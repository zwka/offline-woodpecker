# Offline Chess Puzzle Training

This project generates self-contained chess puzzle sets and lets a player solve them offline while preserving run history.

## Puzzle Content

**Puzzle**:
A chess position and its expected sequence of moves, imported from the Lichess puzzle database. The position shown to the player is after the source record's automatic setup move.
For a mate-in-one Puzzle, any legal checkmate is accepted as the winning move, matching the source database's rule.
_Avoid_: Problem, exercise

**Puzzle Set**:
An immutable, ordered collection of Puzzles produced by the Generator and imported by the Trainer. A set also records the selection criteria and random seed that produced its order.
_Avoid_: Pack, playlist, collection

**Tactic Theme**:
A named chess idea or motif assigned to a Puzzle by the source database, such as fork, pin, or mate.
_Avoid_: Category, tag

## Training

**Run**:
One traversal of a Puzzle Set. A player may start multiple Runs for the same Puzzle Set, but only one Run for that set may be active at a time; each Run keeps its own progress and score.
_Avoid_: Session, attempt

**Abandoned Run**:
An unfinished Run that is closed when the player starts another Run for the same Puzzle Set. It remains in history and cannot be resumed.
_Avoid_: Cancelled Run, deleted Run

**Archived Puzzle Set**:
A Puzzle Set removed from the normal Trainer chooser while its Runs and score history remain available. Archiving does not delete the set or its history.
_Avoid_: Deleted set, hidden pack

**Puzzle Result**:
The outcome of one Puzzle within a Run, including whether it was solved on the first try, whether it was eventually completed, and how many retries occurred.
_Avoid_: Puzzle score, answer

**First-Try Solve**:
A Puzzle Result in which the player completes the entire expected solution without making an incorrect or illegal player move.
_Avoid_: First attempt, perfect solve

**Failure**:
A Puzzle Result whose first try included an incorrect or illegal player move. The Puzzle may still be completed later, but the Result does not earn the Run's point.
_Avoid_: Loss, failed Run

**Eventually Completed**:
A failed Puzzle that the player later solves after using Retry. It remains a Failure for scoring, but records that the solution was eventually completed.
_Avoid_: Recovered solve, partial success

## Applications

**Generator**:
The Chrome application that filters the local source puzzle index and exports Puzzle Sets for the Trainer.
_Avoid_: Builder, exporter

**Trainer**:
The Chrome application that imports Puzzle Sets, runs training Runs, and stores their history locally. It can run as a desktop app or as an Android Chrome PWA.
_Avoid_: Solver, player
