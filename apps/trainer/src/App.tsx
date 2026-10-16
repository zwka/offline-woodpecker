import { useEffect, useRef, useState, type TouchEvent } from "react";
import { Chessboard, type ChessboardOptions } from "react-chessboard";
import type { PieceSymbol } from "chess.js";
import {
  Archive,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Check,
  CheckCircle2,
  CircleHelp,
  DatabaseBackup,
  Download,
  ExternalLink,
  FileUp,
  History,
  Library,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import {
  completePuzzle,
  continuePuzzle,
  markPuzzleError,
  nextAfterPuzzle,
  normalizePuzzleSet,
  parsePuzzleSet,
  retryPuzzle,
  scoreRun,
  type ActiveRun,
  type PuzzleResult,
  type PuzzleSet,
  type Run,
} from "@offline-woodpecker/domain";
import {
  exportTrainerBackup,
  importPuzzleSet,
  loadTrainerData,
  mergeTrainerBackup,
  saveRun,
  savePuzzleSet,
  setArchived,
  deleteSetAndRuns,
  startRunAtomically,
  type StoredPuzzleSet,
  type TrainerData,
} from "./storage";
import { attemptMove, gameAtMoveIndex, isSquare, promotionForDrop, puzzlePosition } from "./puzzle-session";

type ThemeChoice = "system" | "light" | "dark";
type View = "library" | "solve" | "summary" | "history";
type PromotionChoice = Extract<PieceSymbol, "q" | "r" | "b" | "n">;
const GENERATOR_URL = import.meta.env.VITE_GENERATOR_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:4173" : "");

const PROMOTION_CHOICES: Array<{ value: PromotionChoice; label: string }> = [
  { value: "q", label: "Queen" },
  { value: "r", label: "Rook" },
  { value: "b", label: "Bishop" },
  { value: "n", label: "Knight" },
];

function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const stored = window.localStorage.getItem("woodpecker-trainer-theme");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const resolved = choice === "system" ? (systemDark ? "dark" : "light") : choice;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    window.localStorage.setItem("woodpecker-trainer-theme", choice);
  }, [choice, resolved]);

  return { choice, setChoice, resolved };
}

function formatTheme(theme: string): string {
  return theme
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function isThemeChoice(value: string): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ThemeControl({ choice, onChange }: { choice: ThemeChoice; onChange: (value: ThemeChoice) => void }) {
  return (
    <label className="theme-control">
      <span className="sr-only">Color theme</span>
      {choice === "dark" ? <Moon size={16} /> : choice === "light" ? <Sun size={16} /> : <CircleHelp size={16} />}
      <select value={choice} onChange={(event) => { if (isThemeChoice(event.target.value)) onChange(event.target.value); }} aria-label="Color theme">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function SetCard({
  record,
  activeRun,
  latestRun,
  onStart,
  onResume,
  onArchive,
  onDelete,
}: {
  record: StoredPuzzleSet;
  activeRun: ActiveRun | undefined;
  latestRun: Run | undefined;
  onStart: () => void;
  onResume: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const score = latestRun ? scoreRun(latestRun) : null;
  const activeScore = activeRun ? scoreRun(activeRun) : null;
  return (
    <article className="set-card">
      <div className="set-card-topline">
        <span className="set-kicker">{record.set.selection.ratingMin}-{record.set.selection.ratingMax} rating</span>
        <button className="icon-button" type="button" onClick={onArchive} title="Archive set" aria-label={`Archive ${record.set.name}`}><Archive size={16} /></button>
      </div>
      <h3>{record.set.name}</h3>
      <p className="set-description">{record.set.puzzles.length} puzzles / {record.set.selection.themes.length ? record.set.selection.themes.map(formatTheme).join(", ") : "mixed themes"}</p>
      <div className="set-stats">
        <div><span>Source</span><strong>{record.set.source.snapshot}</strong></div>
        <div><span>Runs</span><strong>{latestRun ? "History" : "New"}</strong></div>
        <div><span>Score</span><strong>{score ? `${score.firstTrySolved}/${score.total}` : "-"}</strong></div>
      </div>
      {activeRun && activeScore && (
        <div className="active-run-line"><span className="pulse-dot" /> Active / {activeRun.currentPuzzleIndex + 1} of {activeRun.results.length} / {activeScore.firstTrySolved} scored</div>
      )}
      <div className="set-card-actions">
        {activeRun ? (
          <button className="primary-button compact" type="button" onClick={onResume}><Play size={15} /> Resume</button>
        ) : (
          <button className="primary-button compact" type="button" onClick={onStart}><Play size={15} /> Start new Run</button>
        )}
        {latestRun && <span className="last-run">Last run {formatDate(latestRun.startedAt)}</span>}
      </div>
      <button className="danger-link" type="button" onClick={onDelete}><Trash2 size={13} /> Delete set and history</button>
    </article>
  );
}

function resultLabel(result: PuzzleResult): { label: string; tone: string } {
  if (result.status === "first-try-solved") return { label: "First-try solve", tone: "good" };
  if (result.status === "pending") return { label: "Not reached", tone: "muted" };
  if (result.completion === "completed") return { label: "Completed after error", tone: "warm" };
  if (result.completion === "skipped") return { label: "Skipped", tone: "bad" };
  return { label: "Error recorded", tone: "bad" };
}

function App() {
  const theme = useTheme();
  const [data, setData] = useState<TrainerData | null>(null);
  const [view, setView] = useState<View>("library");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyRunId, setHistoryRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPersisting, setIsPersisting] = useState(false);
  const [startingSetId, setStartingSetId] = useState<string | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: string; to: string; piece: string } | null>(null);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const setInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      try {
        let next = await loadTrainerData();
        const demoSeeded = window.localStorage.getItem("woodpecker-demo-seeded") === "true";
        if (next.sets.length === 0 && !demoSeeded) {
          const response = await fetch("/demo-set.json");
          if (!response.ok) throw new Error("Demo set unavailable");
          const demo = await normalizePuzzleSet(parsePuzzleSet(await response.json()));
          await savePuzzleSet(demo);
          next = { sets: [{ set: demo, archived: false }], runs: [] };
          window.localStorage.setItem("woodpecker-demo-seeded", "true");
        } else if (next.sets.length > 0) {
          window.localStorage.setItem("woodpecker-demo-seeded", "true");
        }
        if (!cancelled) setData(next);
      } catch {
        if (!cancelled) setNotice("Local storage could not be opened. The Trainer needs browser storage to keep Run history.");
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeRun = data?.runs.find((run): run is ActiveRun => run.id === selectedRunId && run.status === "active");
  const selectedSet = activeRun ? data?.sets.find((record) => record.set.id === activeRun.setId)?.set : undefined;
  const historyRun = data?.runs.find((run) => run.id === historyRunId);
  const historySet = historyRun ? data?.sets.find((record) => record.set.id === historyRun.setId)?.set : undefined;
  const visibleSets = data?.sets.filter((record) => !record.archived) ?? [];

  useEffect(() => {
    setSelectedSquare(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [view, selectedRunId]);

  async function updateRun(nextRun: Run) {
    setIsPersisting(true);
    try {
      await saveRun(nextRun);
      setData((current) => current ? {
        ...current,
        runs: current.runs.some((run) => run.id === nextRun.id)
          ? current.runs.map((run) => run.id === nextRun.id ? nextRun : run)
          : [...current.runs, nextRun],
      } : current);
      if (nextRun.status === "completed") setView("summary");
    } catch {
      setNotice("The latest action could not be saved locally. Your previous state is still intact.");
    } finally {
      setIsPersisting(false);
    }
  }

  async function startRun(set: PuzzleSet) {
    if (!data || startingSetId) return;
    setStartingSetId(set.id);
    try {
      const started = await startRunAtomically(set);
      setData({ ...data, runs: started.runs });
      setSelectedRunId(started.run.id);
      setView("solve");
      setNotice(null);
    } catch {
      setNotice("The new Run could not be started locally.");
    } finally {
      setStartingSetId(null);
    }
  }

  function resumeRun(run: Run) {
    if (run.status !== "active") return;
    setSelectedRunId(run.id);
    setView("solve");
    setNotice(null);
  }

  async function archiveSet(setId: string) {
    if (data?.runs.some((run) => run.setId === setId && run.status === "active")) {
      setNotice("Finish or replace the active Run before archiving this set.");
      return;
    }
    await setArchived(setId, true);
    setData((current) => current ? { ...current, sets: current.sets.map((record) => record.set.id === setId ? { ...record, archived: true } : record) } : current);
    setNotice("Puzzle Set archived. Its Run history is still available in History.");
  }

  async function removeSet(setId: string) {
    if (!window.confirm("Delete this Puzzle Set and every Run attached to it? This cannot be undone.")) return;
    await deleteSetAndRuns(setId);
    setData((current) => current ? { sets: current.sets.filter((record) => record.set.id !== setId), runs: current.runs.filter((run) => run.setId !== setId) } : current);
    setNotice("Puzzle Set and its history were deleted.");
  }

  async function handleSetImport(file: File) {
    try {
      const input = JSON.parse(await file.text());
      if (!data) return;
      const result = await importPuzzleSet(input, data);
      if (result.duplicate) {
        setNotice("That Puzzle Set is already in this Trainer.");
        return;
      }
      setData(result.data);
      setNotice("Puzzle Set imported and ready to run.");
    } catch {
      setNotice("This file is not a valid Puzzle Set export.");
    }
  }

  async function handleBackupImport(file: File) {
    try {
      const input = JSON.parse(await file.text());
      if (!data) return;
      const next = await mergeTrainerBackup(input, data);
      setData(next);
      setNotice("Backup merged with local sets and Run history.");
    } catch {
      setNotice("This file is not a valid Trainer backup.");
    }
  }

  async function exportBackup() {
    if (!data) return;
    downloadJson(`woodpecker-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportTrainerBackup(data));
    setNotice("Trainer backup exported.");
  }

  function handleMoveAttempt(from: string, to: string, piece: string, promotion?: PromotionChoice) {
    if (isPersisting || !activeRun || !selectedSet || activeRun.status !== "active") return false;
    const isPawnPromotion = piece.slice(1, 2).toUpperCase() === "P" && ["1", "8"].includes(to.slice(1, 2));
    if (isPawnPromotion && !promotion) {
      setPendingPromotion({ from, to, piece });
      return false;
    }
    const puzzle = selectedSet.puzzles[activeRun.currentPuzzleIndex];
    if (!puzzle) return false;
    const outcome = attemptMove(puzzle, activeRun, from, to, promotion ?? promotionForDrop(piece, to));
    if (outcome.kind === "illegal" || outcome.kind === "incorrect") {
      void updateRun(markPuzzleError(activeRun, outcome.kind));
      setSelectedSquare(null);
      setPendingPromotion(null);
      return false;
    }
    const nextRun = outcome.kind === "continue"
      ? continuePuzzle(activeRun, outcome.moveIndex)
      : completePuzzle(activeRun);
    void updateRun(nextRun);
    setSelectedSquare(null);
    setPendingPromotion(null);
    return true;
  }

  function handleSquareClick(square: string, piece?: string) {
    if (!activeRun || activeRun.currentPuzzle.kind !== "playing" || pendingPromotion) return;
    if (!selectedSquare) {
      if (piece) setSelectedSquare(square);
      return;
    }
    const puzzle = selectedSet?.puzzles[activeRun.currentPuzzleIndex];
    if (!puzzle) return;
    const game = gameAtMoveIndex(puzzle, activeRun.currentPuzzle.moveIndex);
    if (!isSquare(selectedSquare)) return;
    const selectedPiece = game.get(selectedSquare);
    const selectedPieceCode = selectedPiece ? `${selectedPiece.color}${selectedPiece.type}` : "";
    handleMoveAttempt(selectedSquare, square, selectedPieceCode);
  }

  function handleSwipeEnd(event: TouchEvent<HTMLElement>) {
    if (touchStart === null) return;
    const distance = (event.changedTouches[0]?.clientY ?? touchStart) - touchStart;
    setTouchStart(null);
    if (distance < -55) handleNextAfterError();
  }

  function handleNextAfterError() {
    if (isPersisting || !activeRun || activeRun.currentPuzzle.kind === "playing") return;
    void updateRun(nextAfterPuzzle(activeRun));
  }

  function handleRetry() {
    if (isPersisting || !activeRun || activeRun.currentPuzzle.kind !== "error") return;
    void updateRun(retryPuzzle(activeRun));
  }

  function choosePromotion(choice: PromotionChoice) {
    if (!pendingPromotion) return;
    const pending = pendingPromotion;
    setPendingPromotion(null);
    handleMoveAttempt(pending.from, pending.to, pending.piece, choice);
  }

  const latestRunForSet = (setId: string): Run | undefined => data?.runs
    .filter((run) => run.setId === setId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  const activeRunForSet = (setId: string): ActiveRun | undefined => data?.runs.find((run): run is ActiveRun => run.setId === setId && run.status === "active");

  function renderLibrary() {
    return (
      <main className="trainer-main">
        <section className="trainer-intro">
          <div>
            <p className="eyebrow">Training library</p>
            <h1>Keep the first move honest.</h1>
            <p className="intro-copy">Choose a Puzzle Set, solve each position without a safety net, and let the history show what held up under pressure.</p>
          </div>
          <div className="intro-stat"><span className="stat-number">{visibleSets.length}</span><span className="stat-label">active sets</span></div>
        </section>

        <section className="library-toolbar">
          <div><h2>Your Puzzle Sets</h2><span className="toolbar-note">Stored on this device</span></div>
          <div className="toolbar-actions">
            <button className="secondary-button" type="button" onClick={() => backupInputRef.current?.click()}><DatabaseBackup size={16} /> Restore backup</button>
            <button className="secondary-button" type="button" onClick={() => void exportBackup()}><Download size={16} /> Export backup</button>
            <button className="primary-button compact" type="button" onClick={() => setInputRef.current?.click()}><Upload size={16} /> Import set</button>
            <input ref={setInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleSetImport(file); event.target.value = ""; }} />
            <input ref={backupInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleBackupImport(file); event.target.value = ""; }} />
          </div>
        </section>

        {visibleSets.length === 0 ? (
          <div className="empty-library"><FileUp size={23} /><h3>Import your first Puzzle Set</h3><p>Use the Generator export or restore a Trainer backup to begin.</p></div>
        ) : (
          <div className="set-grid">
            {visibleSets.map((record) => (
              <SetCard
                key={record.set.id}
                record={record}
                activeRun={activeRunForSet(record.set.id)}
                latestRun={latestRunForSet(record.set.id)}
                onStart={() => void startRun(record.set)}
                onResume={() => { const run = activeRunForSet(record.set.id); if (run) resumeRun(run); }}
                onArchive={() => void archiveSet(record.set.id)}
                onDelete={() => void removeSet(record.set.id)}
              />
            ))}
          </div>
        )}

        <section className="library-footer-band">
          <div className="footer-band-icon"><ShieldCheck size={20} /></div>
          <div><strong>Local by design</strong><p>Sets, scores, and Run history never leave this browser. Export a backup when you want to move to another device.</p></div>
          <a href="https://database.lichess.org/" target="_blank" rel="noreferrer">Source details <ExternalLink size={14} /></a>
        </section>
      </main>
    );
  }

  function renderSolve() {
    if (!activeRun || !selectedSet) return null;
    const puzzle = selectedSet.puzzles[activeRun.currentPuzzleIndex];
    if (!puzzle) return null;
    const state = activeRun.currentPuzzle;
    const position = puzzlePosition(puzzle, state);
    const score = scoreRun(activeRun);
    const isError = state.kind === "error";
    const isCompletedAfterError = state.kind === "completed-after-error";
    const interactionLocked = isError || isCompletedAfterError;

    const boardOptions: ChessboardOptions = {
      position: position.fen,
      boardOrientation: position.orientation,
      allowDragging: !interactionLocked && !pendingPromotion,
      animationDurationInMs: 160,
      showNotation: true,
      lightSquareStyle: { backgroundColor: "var(--board-light)" },
      darkSquareStyle: { backgroundColor: "var(--board-dark)" },
      boardStyle: { borderRadius: "5px", overflow: "hidden", boxShadow: "0 14px 36px rgba(20, 31, 29, 0.16)" },
      squareStyles: selectedSquare ? { [selectedSquare]: { boxShadow: "inset 0 0 0 4px var(--board-select)" } } : undefined,
      onPieceDrop: ({ sourceSquare, targetSquare, piece }) => targetSquare ? handleMoveAttempt(sourceSquare, targetSquare, piece.pieceType) : false,
      onSquareClick: ({ square, piece }) => handleSquareClick(square, piece?.pieceType),
    };

    return (
      <main className="solve-main" onTouchStart={(event) => setTouchStart(event.touches[0]?.clientY ?? null)} onTouchEnd={handleSwipeEnd}>
        <div className="solve-topline">
          <button className="back-button" type="button" onClick={() => setView("library")}><ArrowLeft size={17} /> Library</button>
          <div className="solve-set-name"><span>{selectedSet.name}</span><span className="separator">/</span><span>{selectedSet.selection.ratingMin}-{selectedSet.selection.ratingMax}</span></div>
          <div className="solve-actions"><span className="solve-score">{score.firstTrySolved} scored</span><span className="solve-counter">{activeRun.currentPuzzleIndex + 1} / {activeRun.results.length}</span></div>
        </div>
        <div className="progress-track"><span style={{ width: `${((activeRun.currentPuzzleIndex) / activeRun.results.length) * 100}%` }} /></div>
        <div className="solve-grid">
          <section className="board-column">
            <div className="board-frame"><Chessboard options={boardOptions} />{pendingPromotion && <div className="promotion-picker"><span>Choose promotion</span><div>{PROMOTION_CHOICES.map((choice) => <button type="button" key={choice.value} onClick={() => choosePromotion(choice.value)}>{choice.label}</button>)}</div></div>}</div>
            <div className="board-caption"><span><span className="turn-dot" /> {position.orientation === "white" ? "White" : "Black"} to solve</span><span>{puzzle.id}</span></div>
          </section>
          <aside className={`solve-panel ${isError ? "error-state" : isCompletedAfterError ? "recovered-state" : ""}`}>
            {isError ? (
              <>
                <div className="state-icon error-icon"><RefreshCw size={22} /></div>
                <p className="eyebrow">First try missed</p>
                <h2>Reset and look again.</h2>
                <p className="solve-copy">The score is recorded as a failure. You can retry this position as many times as needed.</p>
                <div className="solve-panel-actions"><button className="primary-button" type="button" onClick={handleRetry}><RotateCcw size={17} /> Retry puzzle</button><button className="secondary-button" type="button" onClick={handleNextAfterError}><SkipForward size={17} /> Next puzzle</button></div>
                <p className="swipe-hint"><ArrowUp size={14} /> Swipe up on mobile to continue</p>
              </>
            ) : isCompletedAfterError ? (
              <>
                <div className="state-icon recovered-icon"><CheckCircle2 size={23} /></div>
                <p className="eyebrow">Completed after error</p>
                <h2>Good recovery.</h2>
                <p className="solve-copy">The position is complete, but this Puzzle Result remains a failure for the Run score.</p>
                <button className="primary-button" type="button" onClick={handleNextAfterError}><SkipForward size={17} /> Next puzzle</button>
                <p className="swipe-hint"><ArrowUp size={14} /> Swipe up on mobile to continue</p>
              </>
            ) : (
              <>
                <div className="state-icon playing-icon"><BarChart3 size={22} /></div>
                <p className="eyebrow">Puzzle {String(activeRun.currentPuzzleIndex + 1).padStart(2, "0")}</p>
                <h2>Find the best move.</h2>
                <p className="solve-copy">Play the tactical idea. The opponent will answer automatically when your move is correct.</p>
                <div className="solve-meta"><span>First-try score</span><strong>{score.firstTrySolved} / {score.total}</strong></div>
                <div className="solve-tip"><CircleHelp size={16} /><span>Rating and themes stay hidden until this Puzzle is complete.</span></div>
              </>
            )}
            <div className="puzzle-source-link"><span>Source puzzle</span><a href={puzzle.gameUrl} target="_blank" rel="noreferrer">View record <ExternalLink size={13} /></a></div>
          </aside>
        </div>
      </main>
    );
  }

  function renderSummary() {
    const run = data?.runs.find((candidate) => candidate.id === selectedRunId);
    const set = run ? data?.sets.find((record) => record.set.id === run.setId)?.set : undefined;
    if (!run || !set || run.status !== "completed") return null;
    const score = scoreRun(run);
    return (
      <main className="summary-main">
        <div className="summary-header"><button className="back-button" type="button" onClick={() => setView("library")}><ArrowLeft size={17} /> Library</button><span className="summary-date">Completed {formatDate(run.endedAt)}</span></div>
        <section className="summary-hero">
          <div className="score-ring" style={{ background: `conic-gradient(var(--accent) ${score.percentage * 3.6}deg, var(--line) 0)` }}><div><strong>{score.percentage}%</strong><span>first-try score</span></div></div>
          <div className="summary-copy"><p className="eyebrow">Run complete</p><h1>{set.name}</h1><p>You finished all {score.total} puzzles. The score counts only solutions found before the first error.</p><div className="summary-actions"><button className="primary-button" type="button" onClick={() => void startRun(set)}><Play size={17} /> Start another Run</button><button className="secondary-button" type="button" onClick={() => { setHistoryRunId(run.id); setView("history"); }}><History size={16} /> Inspect results</button></div></div>
        </section>
        <div className="summary-metrics"><div><span>First-try solves</span><strong>{score.firstTrySolved}</strong></div><div><span>Completed after error</span><strong>{score.eventuallyCompleted}</strong></div><div><span>Skipped</span><strong>{score.notCompleted}</strong></div><div><span>Run duration</span><strong>{Math.max(1, Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 60000))} min</strong></div></div>
      </main>
    );
  }

  function renderHistory() {
    if (!data) return null;
    const selectedHistory = historyRunId ? data.runs.find((run) => run.id === historyRunId) : undefined;
    const selectedHistorySet = selectedHistory ? data.sets.find((record) => record.set.id === selectedHistory.setId)?.set : undefined;
    return (
      <main className="history-main">
        <div className="history-heading"><div><p className="eyebrow">Performance archive</p><h1>Run history</h1><p className="intro-copy">Every Run keeps its own score, including attempts that ended before completion.</p></div><button className="back-button" type="button" onClick={() => setView("library")}><ArrowLeft size={17} /> Library</button></div>
        <div className="history-grid">
          <section className="history-list">
            {data.runs.length === 0 ? <div className="empty-library"><History size={22} /><h3>No Runs yet</h3><p>Start a Puzzle Set to begin building history.</p></div> : data.runs.slice().sort((left, right) => right.startedAt.localeCompare(left.startedAt)).map((run) => {
              const set = data.sets.find((record) => record.set.id === run.setId)?.set;
              const score = scoreRun(run);
              return <button className={historyRunId === run.id ? "history-row selected" : "history-row"} type="button" key={run.id} onClick={() => setHistoryRunId(run.id)}><span className={`history-status ${run.status}`} /> <span className="history-row-copy"><strong>{set?.name ?? "Archived Puzzle Set"}</strong><small>{formatDate(run.startedAt)} / {run.status}</small></span><span className="history-row-score">{score.firstTrySolved}/{score.total}<small>{score.percentage}%</small></span></button>;
            })}
          </section>
          <section className="history-detail">
            {selectedHistory && selectedHistorySet ? (
              <>
                <div className="history-detail-heading"><div><p className="eyebrow">Run detail</p><h2>{selectedHistorySet.name}</h2></div><span className={`run-badge ${selectedHistory.status}`}>{selectedHistory.status}</span></div>
                <div className="detail-score"><strong>{scoreRun(selectedHistory).firstTrySolved}/{scoreRun(selectedHistory).total}</strong><span>first-try score / {scoreRun(selectedHistory).percentage}%</span></div>
                <div className="result-list">{selectedHistory.results.map((result, index) => { const label = resultLabel(result); const puzzle = selectedHistorySet.puzzles[index]; return <div className="result-row" key={`${selectedHistory.id}-${result.puzzleId}`}><span className="result-index">{String(index + 1).padStart(2, "0")}</span><span className="result-puzzle"><strong>{puzzle?.id ?? result.puzzleId}</strong><small>{puzzle?.themes.slice(0, 2).map(formatTheme).join(" / ")}</small></span><span className={`result-label ${label.tone}`}>{label.tone === "good" ? <Check size={13} /> : label.tone === "warm" ? <CheckCircle2 size={13} /> : null}{label.label}</span><span className="result-retries">{result.retryCount} retries</span></div>; })}</div>
              </>
            ) : <div className="history-placeholder"><History size={26} /><h3>Select a Run</h3><p>Choose a record to inspect its Puzzle Results.</p></div>}
          </section>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell trainer-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">W</div><div><div className="brand-name">Woodpecker</div><div className="brand-section">Trainer</div></div></div>
        <nav className="app-nav" aria-label="Primary navigation">
          <button className={view === "library" ? "nav-button active" : "nav-button"} type="button" onClick={() => setView("library")}><Library size={15} /> Library</button>
          <button className={view === "history" ? "nav-button active" : "nav-button"} type="button" onClick={() => setView("history")}><History size={15} /> History</button>
        </nav>
        <div className="topbar-actions">{GENERATOR_URL && <a className="quiet-link" href={GENERATOR_URL} target="_blank" rel="noreferrer">Open Generator <ExternalLink size={15} /></a>}<ThemeControl choice={theme.choice} onChange={theme.setChoice} /></div>
      </header>
      {notice && <button className="global-notice" type="button" onClick={() => setNotice(null)}>{notice}<span aria-hidden="true">x</span></button>}
      {!data ? <main className="loading-screen"><RefreshCw className="spin" size={22} /><span>Opening local Trainer storage...</span></main> : view === "library" ? renderLibrary() : view === "solve" ? renderSolve() : view === "summary" ? renderSummary() : renderHistory()}
      <footer className="app-footer"><span>Woodpecker / local-first chess practice</span><span>Pieces: Cburnett, CC BY-SA 3.0 / <a href="https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard_transparent" target="_blank" rel="noreferrer">source notice</a></span></footer>
    </div>
  );
}

export default App;
