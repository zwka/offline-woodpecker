import {
  abandonRun,
  createRun,
  normalizePuzzleSet,
  parseRun,
  parsePuzzleSet,
  parseTrainerBackup,
  type PuzzleSet,
  type ActiveRun,
  type Run,
  type TrainerBackup,
} from "@offline-woodpecker/domain";
import { validatePuzzleSet } from "./puzzle-session";

const DATABASE_NAME = "offline-woodpecker-trainer";
const DATABASE_VERSION = 1;
const SETS_STORE = "puzzle-sets";
const RUNS_STORE = "runs";

export type StoredPuzzleSet = {
  set: PuzzleSet;
  archived: boolean;
};

export type TrainerData = {
  sets: StoredPuzzleSet[];
  runs: Run[];
};

function runMatchesSet(run: Run, set: PuzzleSet): boolean {
  if (run.results.length !== set.puzzles.length) return false;
  if (run.results.some((result, index) => result.puzzleId !== set.puzzles[index]?.id)) return false;
  if (run.status !== "active") return true;
  if (run.currentPuzzleIndex >= set.puzzles.length) return false;
  const puzzle = set.puzzles[run.currentPuzzleIndex];
  return run.currentPuzzle.kind === "completed-after-error" || run.currentPuzzle.moveIndex < puzzle.moves.length;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SETS_STORE)) {
        database.createObjectStore(SETS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(RUNS_STORE)) {
        const runs = database.createObjectStore(RUNS_STORE, { keyPath: "id" });
        runs.createIndex("setId", "setId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
  });
}

export async function loadTrainerData(): Promise<TrainerData> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([SETS_STORE, RUNS_STORE], "readonly");
    const complete = transactionComplete(transaction);
    const storedSets = await requestValue<unknown[]>(transaction.objectStore(SETS_STORE).getAll());
    const storedRuns = await requestValue<unknown[]>(transaction.objectStore(RUNS_STORE).getAll());
    await complete;

    const sets = storedSets.flatMap((value) => {
      if (!value || typeof value !== "object" || !("set" in value)) return [];
      try {
        const set = parsePuzzleSet(value.set);
        validatePuzzleSet(set);
        return [{ set, archived: "archived" in value && value.archived === true }];
      } catch {
        return [];
      }
    });
    const setsById = new Map(sets.map((record) => [record.set.id, record.set]));
    const runs = storedRuns.flatMap((value) => {
      try {
        const run = parseRun(value);
        const set = setsById.get(run.setId);
        return set && runMatchesSet(run, set) ? [run] : [];
      } catch {
        return [];
      }
    });
    return { sets, runs };
  } finally {
    database.close();
  }
}

export async function savePuzzleSet(set: PuzzleSet, archived = false): Promise<void> {
  validatePuzzleSet(set);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(SETS_STORE, "readwrite");
    transaction.objectStore(SETS_STORE).put({ id: set.id, set, archived });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function setArchived(setId: string, archived: boolean): Promise<void> {
  const data = await loadTrainerData();
  const record = data.sets.find((candidate) => candidate.set.id === setId);
  if (!record) throw new Error("Puzzle Set not found");
  await savePuzzleSet(record.set, archived);
}

export async function saveRun(run: Run): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(RUNS_STORE, "readwrite");
    transaction.objectStore(RUNS_STORE).put(run);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function startRunAtomically(set: PuzzleSet): Promise<{ run: ActiveRun; runs: Run[] }> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(RUNS_STORE, "readwrite");
      const store = transaction.objectStore(RUNS_STORE);
      let result: { run: ActiveRun; runs: Run[] } | null = null;
      let failure: Error | null = null;

      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (result) resolve(result);
        else reject(new Error("Run transaction completed without a result"));
      };
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not start Run"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Run transaction aborted"));

      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const parsedRuns = request.result.flatMap((value) => {
            try {
              return [parseRun(value)];
            } catch {
              return [];
            }
          });
          const timestamp = new Date().toISOString();
          const abandonedRuns = parsedRuns.map((run) => {
            if (run.setId === set.id && run.status === "active") {
              const abandoned = abandonRun(run, timestamp);
              store.put(abandoned);
              return abandoned;
            }
            return run;
          });
          const run = createRun(set, timestamp);
          store.put(run);
          result = { run, runs: [...abandonedRuns, run] };
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
        }
      };
      request.onerror = () => {
        failure = request.error ?? new Error("Could not read Run history");
        transaction.abort();
      };
    });
  } finally {
    database.close();
  }
}

export async function deleteSetAndRuns(setId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([SETS_STORE, RUNS_STORE], "readwrite");
    const complete = transactionComplete(transaction);
    transaction.objectStore(SETS_STORE).delete(setId);
    const runsStore = transaction.objectStore(RUNS_STORE);
    const runs = await requestValue<unknown[]>(runsStore.index("setId").getAll(setId));
    for (const value of runs) {
      if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
        runsStore.delete(value.id);
      }
    }
    await complete;
  } finally {
    database.close();
  }
}

export async function exportTrainerBackup(data: TrainerData): Promise<TrainerBackup> {
  return {
    kind: "trainer-backup",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    puzzleSets: data.sets.map((record) => ({ set: record.set, archived: record.archived })),
    runs: data.runs,
  };
}

export async function mergeTrainerBackup(input: unknown, existing: TrainerData): Promise<TrainerData> {
  const backup = parseTrainerBackup(input);
  const nextSets = [...existing.sets];
  const setIdMap = new Map<string, string>();
  const pendingSets: StoredPuzzleSet[] = [];

  for (const incomingRecord of backup.puzzleSets) {
    const incoming = incomingRecord.set;
    const normalized = await normalizePuzzleSet(incoming);
    validatePuzzleSet(normalized);
    const duplicate = nextSets.find((record) => record.set.contentHash === normalized.contentHash);
    if (duplicate) {
      setIdMap.set(incoming.id, duplicate.set.id);
      if (incomingRecord.archived && !duplicate.archived) {
        const archived = { ...duplicate, archived: true };
        const duplicateIndex = nextSets.indexOf(duplicate);
        nextSets[duplicateIndex] = archived;
        pendingSets.push(archived);
      }
      continue;
    }
    const collidingId = nextSets.some((record) => record.set.id === incoming.id);
    const set = collidingId ? { ...normalized, id: globalThis.crypto.randomUUID() } : normalized;
    const record = { set, archived: incomingRecord.archived };
    nextSets.push(record);
    pendingSets.push(record);
    setIdMap.set(incoming.id, set.id);
  }

  const nextRuns = [...existing.runs];
  const existingRunIds = new Set(nextRuns.map((run) => run.id));
  const pendingRuns: Run[] = [];
  for (const incoming of backup.runs) {
    const mappedSetId = setIdMap.get(incoming.setId) ?? incoming.setId;
    if (existingRunIds.has(incoming.id)) continue;
    const mappedSet = nextSets.find((record) => record.set.id === mappedSetId)?.set;
    if (!mappedSet || !runMatchesSet(incoming, mappedSet)) {
      throw new Error(`Backup Run ${incoming.id} does not match an imported Puzzle Set`);
    }
    const activeConflict = nextRuns.some((run) => run.setId === mappedSetId && run.status === "active");
    const mapped = incoming.setId === mappedSetId ? incoming : { ...incoming, setId: mappedSetId };
    const runToSave: Run = activeConflict && mapped.status === "active" ? abandonRun(mapped) : mapped;
    pendingRuns.push(runToSave);
    nextRuns.push(runToSave);
    existingRunIds.add(runToSave.id);
  }

  for (const record of pendingSets) await savePuzzleSet(record.set, record.archived);
  for (const run of pendingRuns) await saveRun(run);

  return { sets: nextSets, runs: nextRuns };
}

export async function importPuzzleSet(input: unknown, existing: TrainerData): Promise<{ data: TrainerData; duplicate: boolean }> {
  const incoming = await normalizePuzzleSet(parsePuzzleSet(input));
  validatePuzzleSet(incoming);
  const duplicate = existing.sets.some((record) => record.set.contentHash === incoming.contentHash);
  if (duplicate) return { data: existing, duplicate: true };
  const idCollision = existing.sets.some((record) => record.set.id === incoming.id);
  const set = idCollision ? { ...incoming, id: globalThis.crypto.randomUUID() } : incoming;
  await savePuzzleSet(set, false);
  return { data: { ...existing, sets: [...existing.sets, { set, archived: false }] }, duplicate: false };
}
