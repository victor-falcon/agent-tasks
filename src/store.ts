import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AgentTasksError, CorruptFileError, NotFoundError, UsageError } from "./errors.ts";
import type { DataPaths } from "./paths.ts";
import { type Run, runErrors, type Task, TASK_ID_RE, taskErrors, type Tick } from "./schema.ts";
import { isManualSlotId, isSlotId, parseRunRef, runRef, runSlotId, slotIdToDate } from "./slot.ts";

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

function serialize(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Writes JSON so readers never see a half-written file: temp file in the same folder + rename. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, serialize(data), { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Creates `path` with `data` only if it does not exist yet. Returns false when
 * another process got there first. The content is written to a temp file and
 * then hard-linked into place: `link` fails if the target exists (like `wx`)
 * and the file appears complete, never half-written.
 */
export function createJsonExclusive(path: string, data: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    writeFileSync(tmp, serialize(data), { flag: "wx" });
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Reads and parses a JSON file. Unparseable content raises CorruptFileError. */
export function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CorruptFileError(path, `not valid JSON (${(err as Error).message})`);
  }
}

function readValidated<T>(path: string, check: (v: unknown) => string[]): T {
  const value = readJson(path);
  const errors = check(value);
  if (errors.length > 0) throw new CorruptFileError(path, errors.join("; "));
  return value as T;
}

/** A list of items plus the files that could not be read, so callers can report them. */
export interface ReadResult<T> {
  items: T[];
  errors: CorruptFileError[];
}

function collect<T>(paths: string[], read: (path: string) => T): ReadResult<T> {
  const result: ReadResult<T> = { items: [], errors: [] };
  for (const path of paths) {
    try {
      result.items.push(read(path));
    } catch (err) {
      if (err instanceof CorruptFileError) result.errors.push(err);
      else throw err;
    }
  }
  return result;
}

function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .map((f) => join(dir, f));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function taskPath(paths: DataPaths, id: string): string {
  if (!TASK_ID_RE.test(id)) throw new UsageError(`invalid task id "${id}" (lowercase letters, digits and dashes)`);
  return join(paths.tasksDir, `${id}.json`);
}

/** Reads and validates a task file at any path. */
export function readTaskFile(path: string): Task {
  return readValidated<Task>(path, taskErrors);
}

export function readTask(paths: DataPaths, id: string): Task {
  const path = taskPath(paths, id);
  if (!existsSync(path)) throw new NotFoundError(`task "${id}" not found in ${paths.tasksDir}`);
  const task = readTaskFile(path);
  if (task.id !== id) throw new CorruptFileError(path, `id "${task.id}" does not match the file name`);
  return task;
}

/**
 * Loads a task from a command argument: a path (anything with a `/` or ending
 * in `.json`, relative to `cwd`) or the id of a saved task.
 */
export function loadTaskArg(paths: DataPaths, arg: string, resolveArgPath: (p: string) => string): { task: Task; file: string } {
  if (arg.includes("/") || arg.endsWith(".json")) {
    const file = resolveArgPath(arg);
    if (!existsSync(file)) throw new NotFoundError(`task file not found: ${file}`);
    return { task: readTaskFile(file), file };
  }
  return { task: readTask(paths, arg), file: taskPath(paths, arg) };
}

export function taskExists(paths: DataPaths, id: string): boolean {
  return existsSync(taskPath(paths, id));
}

export function writeTask(paths: DataPaths, task: Task): void {
  writeJsonAtomic(taskPath(paths, task.id), task);
}

export function listTasks(paths: DataPaths): ReadResult<Task> {
  return collect(jsonFilesIn(paths.tasksDir), (path) => {
    const task = readTaskFile(path);
    if (`${task.id}.json` !== basename(path)) throw new CorruptFileError(path, `id "${task.id}" does not match the file name`);
    return task;
  });
}

// ---------------------------------------------------------------------------
// Runs (occurrences)
// ---------------------------------------------------------------------------

export function runPath(paths: DataPaths, taskId: string, slot: string): string {
  parseRunRef(runRef(taskId, slot)); // rejects ids that could escape the runs folder
  return join(paths.runsDir, taskId, `${slot}.json`);
}

/** Captured output of a run, relative to the data folder (as stored in `attempt.log`). */
export function runLogRelativePath(taskId: string, slot: string): string {
  return `runs/${taskId}/${slot}.log`;
}

function readRunFile(path: string, taskId: string, slot: string): Run {
  const run = readValidated<Run>(path, runErrors);
  if (run.task_id !== taskId || runSlotId(run) !== slot) {
    throw new CorruptFileError(path, `content (${runRef(run.task_id, runSlotId(run))}) does not match the file name`);
  }
  return run;
}

export function readRun(paths: DataPaths, taskId: string, slot: string): Run {
  const path = runPath(paths, taskId, slot);
  if (!existsSync(path)) throw new NotFoundError(`run "${runRef(taskId, slot)}" not found`);
  return readRunFile(path, taskId, slot);
}

export function readRunByRef(paths: DataPaths, ref: string): Run {
  const { taskId, slot } = parseRunRef(ref);
  return readRun(paths, taskId, slot);
}

/**
 * Claims an occurrence by creating its file (named after `runSlotId(run)`).
 * Returns false if it already exists (another tick or runner took it), so
 * each slot runs at most once.
 */
export function claimRun(paths: DataPaths, run: Run): boolean {
  return createJsonExclusive(runPath(paths, run.task_id, runSlotId(run)), run);
}

/** Replaces an existing run file atomically. */
export function writeRun(paths: DataPaths, run: Run): void {
  writeJsonAtomic(runPath(paths, run.task_id, runSlotId(run)), run);
}

export interface StoredRun {
  /** File-safe slot id (the file name without `.json`). */
  slot: string;
  ref: string;
  run: Run;
}

/** Every occurrence of a task, oldest first (manual runs after scheduled ones of the same instant). */
export function listRuns(paths: DataPaths, taskId: string): ReadResult<StoredRun> {
  const files = jsonFilesIn(join(paths.runsDir, taskId)).filter((f) => isSlotId(basename(f, ".json")));
  const result = collect(files, (path) => {
    const slot = basename(path, ".json");
    return { slot, ref: runRef(taskId, slot), run: readRunFile(path, taskId, slot) };
  });
  result.items.sort((a, b) => slotIdToDate(a.slot).getTime() - slotIdToDate(b.slot).getTime() || a.slot.localeCompare(b.slot));
  return result;
}

/** The `limit` most recent occurrences of a task, newest first. */
export function latestRuns(paths: DataPaths, taskId: string, limit: number): ReadResult<StoredRun> {
  const all = listRuns(paths, taskId);
  return { items: all.items.reverse().slice(0, limit), errors: all.errors };
}

/**
 * Slot ids that already have a file, including unreadable ones (they are
 * recorded, just broken). Run files are never moved or pruned: archiving a
 * task keeps its history in `runs/`, so a slot recorded once stays recorded.
 */
export function recordedSlots(paths: DataPaths, taskId: string): Set<string> {
  const dir = join(paths.runsDir, taskId);
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => basename(f, ".json"))
      .filter((id) => isSlotId(id) && !isManualSlotId(id)),
  );
}

// ---------------------------------------------------------------------------
// Heartbeat: state/ticks.jsonl
// ---------------------------------------------------------------------------

/** Appends one line to the heartbeat log. */
export function appendTick(paths: DataPaths, tick: Tick): void {
  mkdirSync(paths.stateDir, { recursive: true });
  appendFileSync(paths.ticksFile, `${JSON.stringify(tick)}\n`);
}

/** Reads the heartbeat log. Unparseable lines are returned as errors, never dropped silently. */
export function readTicks(paths: DataPaths): ReadResult<Tick> {
  const result: ReadResult<Tick> = { items: [], errors: [] };
  if (!existsSync(paths.ticksFile)) return result;
  const lines = readFileSync(paths.ticksFile, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      const tick = JSON.parse(line) as Tick;
      if (typeof tick?.at !== "string" || Number.isNaN(Date.parse(tick.at))) throw new Error("missing or invalid `at`");
      result.items.push(tick);
    } catch (err) {
      result.errors.push(new CorruptFileError(`${paths.ticksFile}:${i + 1}`, (err as Error).message));
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Archive: deleted tasks (`archive/<id>.json`); their runs stay in `runs/`
// ---------------------------------------------------------------------------

export function archivedTaskPath(paths: DataPaths, id: string): string {
  if (!TASK_ID_RE.test(id)) throw new UsageError(`invalid task id "${id}" (lowercase letters, digits and dashes)`);
  return join(paths.archiveDir, `${id}.json`);
}

export function isArchived(paths: DataPaths, id: string): boolean {
  return existsSync(archivedTaskPath(paths, id));
}

export function readArchivedTask(paths: DataPaths, id: string): Task {
  const path = archivedTaskPath(paths, id);
  if (!existsSync(path)) throw new NotFoundError(`task "${id}" not found in ${paths.archiveDir}`);
  const task = readTaskFile(path);
  if (task.id !== id) throw new CorruptFileError(path, `id "${task.id}" does not match the file name`);
  return task;
}

export function listArchivedTasks(paths: DataPaths): ReadResult<Task> {
  return collect(jsonFilesIn(paths.archiveDir), (path) => {
    const task = readTaskFile(path);
    if (`${task.id}.json` !== basename(path)) throw new CorruptFileError(path, `id "${task.id}" does not match the file name`);
    return task;
  });
}

/**
 * Moves a task to the archive: writes `task` (normally the stored task, paused)
 * to `archive/<id>.json`, then removes `tasks/<id>.json`. Refuses to overwrite
 * an archived task with the same id.
 */
export function archiveTask(paths: DataPaths, task: Task): string {
  const target = archivedTaskPath(paths, task.id);
  if (!createJsonExclusive(target, task)) {
    throw new AgentTasksError("conflict", `an archived task "${task.id}" already exists in ${paths.archiveDir}`);
  }
  rmSync(taskPath(paths, task.id), { force: true });
  return target;
}

/** Ids of every task that has runs on disk (including archived or removed tasks). */
export function taskIdsWithRuns(paths: DataPaths): string[] {
  if (!existsSync(paths.runsDir)) return [];
  return readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && TASK_ID_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}
