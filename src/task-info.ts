import { isHub, knownMachines, localMachine, type Resolution, type UserConfig } from "./config.ts";
import type { Context } from "./context.ts";
import { parseDuration } from "./duration.ts";
import type { DataPaths } from "./paths.ts";
import { isTaskFinished, nextRunTimes, planSlots, type SlotPlan } from "./schedule.ts";
import type { Run, RunStatus, Task } from "./schema.ts";
import { NotFoundError, UsageError } from "./errors.ts";
import { archivedTaskPath, isArchived, listRuns, readArchivedTask, readTask, readTicks, recordedSlots, type StoredRun, taskExists } from "./store.ts";
import { slotId } from "./slot.ts";
import { formatInZone, isIsoTimestamp, systemTimezone } from "./time.ts";

// Read-only views of a task shared by `add`, `list`, `show`, `edit`, `due`…

export const TASK_STATES = ["active", "paused", "finished", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * Whether a `once` task is done. Only the run of its current `at` counts, so
 * editing `--at` to a new time brings a finished task back.
 */
export function onceFinished(task: Task, runs: readonly Pick<Run, "trigger" | "status" | "slot">[]): boolean {
  if (task.schedule.type !== "once") return false;
  const current = slotId(new Date(task.schedule.at));
  return isTaskFinished(task, runs.filter((r) => slotId(new Date(r.slot)) === current));
}

export function taskState(task: Task, runs: readonly Pick<Run, "trigger" | "status" | "slot">[], archived = false): TaskState {
  if (archived) return "archived";
  if (onceFinished(task, runs)) return "finished";
  return task.enabled ? "active" : "paused";
}

/** The lower bound for cron slots passed to `planSlots` (set by `edit` and `resume`). */
export function scheduleSince(task: Pick<Task, "schedule_since">): Date | undefined {
  return task.schedule_since ? new Date(task.schedule_since) : undefined;
}

/** A task with its state, resolved settings and next runs (none unless it is active). */
export interface TaskOverview {
  task: Task;
  state: TaskState;
  resolution: Resolution;
  next: string[];
  runs: StoredRun[];
  /** Run files that could not be read. */
  errors: Error[];
}

export function taskOverview(ctx: Context, task: Task, { archived = false, nextCount = 3 } = {}): TaskOverview {
  const runs = listRuns(ctx.paths, task.id);
  const state = taskState(task, runs.items.map((r) => r.run), archived);
  const resolution = ctx.resolveFor(task);
  const next = state === "active" ? nextRunTimes(task, ctx.now, nextCount, resolution.timezone).map((d) => formatInZone(d, resolution.timezone)) : [];
  return { task, state, resolution, next, runs: runs.items, errors: runs.errors };
}

/** `Next runs (Europe/Madrid):` and one line per run, or why there are none. */
export function describeNext({ next, state, resolution }: Pick<TaskOverview, "next" | "state" | "resolution">): string {
  if (next.length === 0) return `No upcoming runs (${state}).`;
  return `Next runs (${resolution.timezone}):\n${next.map((t) => `  ${t}`).join("\n")}`;
}

/** One line: `once at …` or `cron "…" in …, from …, until …`. */
export function describeSchedule(task: Pick<Task, "schedule">): string {
  const s = task.schedule;
  if (s.type === "once") return `once at ${s.at}`;
  return `cron "${s.cron}"${s.timezone ? ` in ${s.timezone}` : ""}${s.starts_at ? `, from ${s.starts_at}` : ""}${s.until ? `, until ${s.until}` : ""}`;
}

/** Time zone for times not tied to one task: the config's, else the system's. */
export function displayTimezone(ctx: Context): string {
  return ctx.config.config.timezone ?? systemTimezone();
}

/** "Now" as an ISO timestamp with offset, in the display time zone (for created_at, updated_at…). */
export function nowIso(ctx: Context): string {
  return formatInZone(ctx.now, displayTimezone(ctx));
}

/**
 * What `tick` would do with the task's unrecorded slots right now: `planSlots`
 * with `schedule_since` and the `once` finished rule applied. Reads the run
 * files and the heartbeat, writes nothing.
 */
export function planTask(paths: DataPaths, task: Task, resolution: Resolution, now: Date, runs?: readonly StoredRun[]): SlotPlan {
  const stored = runs ?? listRuns(paths, task.id).items;
  return planSlots({
    task,
    now,
    recorded: recordedSlots(paths, task.id),
    ticks: readTicks(paths).items.map((t) => new Date(t.at)),
    settings: resolution,
    finished: onceFinished(task, stored.map((r) => r.run)),
    since: scheduleSince(task),
  });
}

/** One occurrence as shown by `show` and `runs`. */
export interface RunView {
  ref: string;
  task_id: string;
  slot: string;
  trigger: Run["trigger"];
  status: RunStatus;
  reason: string | null;
  attempts: number;
  summary: string | null;
}

export function runView(stored: StoredRun): RunView {
  const { run } = stored;
  const last = run.attempts.at(-1);
  return {
    ref: stored.ref,
    task_id: run.task_id,
    slot: run.slot,
    trigger: run.trigger,
    status: run.status,
    reason: run.reason,
    attempts: run.attempts.length,
    summary: last?.summary ?? null,
  };
}

/** Plain, aligned columns. The first row is the header. */
export function table([header, ...body]: [string[], ...string[][]]): string {
  const rows = [header, ...body];
  const widths = header.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

/** `7d`, `24h`… back from `now`, or an ISO timestamp. */
export function parseSince(value: string, now: Date): Date {
  if (isIsoTimestamp(value)) return new Date(value);
  try {
    return new Date(now.getTime() - parseDuration(value));
  } catch {
    throw new UsageError(`--since: expected a duration such as 7d or 24h, or an ISO time with offset (got "${value}")`);
  }
}

/** Prints unreadable files as warnings (human output only; JSON output lists them). */
export function warnCorrupt(ctx: Context, errors: readonly Error[]): void {
  if (ctx.json) return;
  for (const err of errors) ctx.stderr.write(`warning: ${err.message}\n`);
}

/** A saved (not archived) task; an archived id gets a hint on how to restore it. */
export function readActiveTask(ctx: Context, id: string): Task {
  if (!taskExists(ctx.paths, id) && isArchived(ctx.paths, id)) {
    throw new NotFoundError(`task "${id}" is archived; restore it first: mv ${archivedTaskPath(ctx.paths, id)} ${ctx.paths.tasksDir}/ && agent-tasks resume ${id}`);
  }
  return readTask(ctx.paths, id);
}

/** A saved task, or an archived one (`archived: true`). */
export function findTask(ctx: Context, id: string): { task: Task; archived: boolean } {
  if (taskExists(ctx.paths, id)) return { task: readTask(ctx.paths, id), archived: false };
  if (isArchived(ctx.paths, id)) return { task: readArchivedTask(ctx.paths, id), archived: true };
  throw new NotFoundError(`task "${id}" not found (run "agent-tasks list --all" to see every task)`);
}

/**
 * Whether views name each task's machine: when the config has other machines
 * (or this one is a client), or a task runs somewhere else. A single-machine
 * install never sees it.
 */
export function showMachineColumn(config: UserConfig, tasks: readonly Pick<Task, "machine">[]): boolean {
  if (!isHub(config) || Object.keys(knownMachines(config)).length > 1) return true;
  const self = localMachine(config);
  return tasks.some((t) => t.machine !== self);
}
