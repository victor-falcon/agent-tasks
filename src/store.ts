import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CorruptFileError, NotFoundError, UsageError } from "./errors.ts";
import type { DataPaths } from "./paths.ts";
import { type Run, runErrors, type Task, TASK_ID_RE, taskErrors, type Tick } from "./schema.ts";

// ---------------------------------------------------------------------------
// Slot ids and run refs
// ---------------------------------------------------------------------------

const SLOT_ID_RE = /^(manual-)?(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** File-safe slot id in UTC: `20261117T080000Z`. Sub-second precision is dropped. */
export function slotId(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** Slot id of a manual run: `manual-20261117T080000Z`. */
export function manualSlotId(date: Date): string {
  return `manual-${slotId(date)}`;
}

export function isSlotId(id: string): boolean {
  return SLOT_ID_RE.test(id);
}

export function isManualSlotId(id: string): boolean {
  return id.startsWith("manual-") && isSlotId(id);
}

/** The instant a slot id stands for. */
export function slotIdToDate(id: string): Date {
  const m = SLOT_ID_RE.exec(id);
  if (!m) throw new UsageError(`invalid slot "${id}" (expected e.g. 20261117T080000Z or manual-20261117T080000Z)`);
  const [, , y, mo, d, h, mi, s] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

/** `<task-id>/<slot-id>`, the handle subagents and commands use for one occurrence. */
export function runRef(taskId: string, slot: string): string {
  return `${taskId}/${slot}`;
}

export function parseRunRef(ref: string): { taskId: string; slot: string } {
  const parts = ref.split("/");
  if (parts.length !== 2 || !TASK_ID_RE.test(parts[0]!) || !isSlotId(parts[1]!)) {
    throw new UsageError(`invalid run ref "${ref}" (expected <task-id>/<slot>, e.g. weekly-report/20261117T080000Z)`);
  }
  return { taskId: parts[0]!, slot: parts[1]! };
}

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
    if (existsSync(tmp)) unlinkSync(tmp);
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
  writeFileSync(tmp, serialize(data), { flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(tmp);
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
  return join(paths.runsDir, taskId, `${slot}.json`);
}

/** Captured output of a run, relative to the data folder (as stored in `attempt.log`). */
export function runLogRelativePath(taskId: string, slot: string): string {
  return `runs/${taskId}/${slot}.log`;
}

export function readRun(paths: DataPaths, taskId: string, slot: string): Run {
  const path = runPath(paths, taskId, slot);
  if (!existsSync(path)) throw new NotFoundError(`run "${runRef(taskId, slot)}" not found`);
  return readValidated<Run>(path, runErrors);
}

export function readRunByRef(paths: DataPaths, ref: string): Run {
  const { taskId, slot } = parseRunRef(ref);
  return readRun(paths, taskId, slot);
}

/**
 * Claims an occurrence by creating its file. Returns false if it already
 * exists (another tick or runner took it), so each slot runs at most once.
 */
export function claimRun(paths: DataPaths, slot: string, run: Run): boolean {
  return createJsonExclusive(runPath(paths, run.task_id, slot), run);
}

/** Replaces an existing run file atomically. */
export function writeRun(paths: DataPaths, slot: string, run: Run): void {
  writeJsonAtomic(runPath(paths, run.task_id, slot), run);
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
    return { slot, ref: runRef(taskId, slot), run: readValidated<Run>(path, runErrors) };
  });
  result.items.sort((a, b) => slotIdToDate(a.slot).getTime() - slotIdToDate(b.slot).getTime() || a.slot.localeCompare(b.slot));
  return result;
}

/** The `limit` most recent occurrences of a task, newest first. */
export function latestRuns(paths: DataPaths, taskId: string, limit: number): ReadResult<StoredRun> {
  const all = listRuns(paths, taskId);
  return { items: all.items.reverse().slice(0, limit), errors: all.errors };
}

/** Slot ids that already have a file, including unreadable ones (they are recorded, just broken). */
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
