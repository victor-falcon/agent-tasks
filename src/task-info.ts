import type { Resolution } from "./config.ts";
import type { Context } from "./context.ts";
import { parseDuration } from "./duration.ts";
import type { DataPaths } from "./paths.ts";
import { isTaskFinished, nextRunTimes, planSlots, type SlotPlan } from "./schedule.ts";
import type { Run, RunStatus, Task } from "./schema.ts";
import { NotFoundError } from "./errors.ts";
import { isArchived, listRuns, readArchivedTask, readTask, readTicks, recordedSlots, type StoredRun, taskExists } from "./store.ts";
import { formatInZone } from "./time.ts";

// Read-only views of a task shared by `add`, `list`, `show`, `edit`, `due`…

export const TASK_STATES = ["active", "paused", "finished", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export function taskState(task: Task, runs: readonly Pick<Run, "trigger" | "status">[], archived = false): TaskState {
  if (archived) return "archived";
  if (isTaskFinished(task, runs)) return "finished";
  return task.enabled ? "active" : "paused";
}

/** The lower bound for cron slots passed to `planSlots` (set by `edit` and `resume`). */
export function scheduleSince(task: Pick<Task, "schedule_since">): Date | undefined {
  return task.schedule_since ? new Date(task.schedule_since) : undefined;
}

/** The next `count` runs, formatted in the task's time zone. None for paused, finished or archived tasks. */
export function nextRuns(task: Task, state: TaskState, resolution: Resolution, now: Date, count: number): string[] {
  if (state !== "active") return [];
  return nextRunTimes(task, now, count, resolution.timezone).map((d) => formatInZone(d, resolution.timezone));
}

/**
 * What `tick` would do with the task's unrecorded slots right now. Reads the
 * run files and the heartbeat, writes nothing.
 */
export function planTask(paths: DataPaths, task: Task, resolution: Resolution, now: Date, runs?: readonly StoredRun[]): SlotPlan {
  const stored = runs ?? listRuns(paths, task.id).items;
  return planSlots({
    task,
    now,
    recorded: recordedSlots(paths, task.id),
    ticks: readTicks(paths).items.map((t) => new Date(t.at)),
    settings: resolution,
    finished: isTaskFinished(task, stored.map((r) => r.run)),
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
export function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

/** `7d`, `24h`… or an ISO timestamp, as an instant relative to `now`. */
export function parseSince(value: string, ctx: Pick<Context, "now">): Date {
  const asDate = Date.parse(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(asDate)) return new Date(asDate);
  return new Date(ctx.now.getTime() - parseDuration(value));
}

/** Prints unreadable files as warnings (human output only; JSON output lists them). */
export function warnCorrupt(ctx: Context, errors: readonly Error[]): void {
  if (ctx.json) return;
  for (const err of errors) ctx.stderr.write(`warning: ${err.message}\n`);
}

/** A saved task, or an archived one (`archived: true`). */
export function findTask(ctx: Context, id: string): { task: Task; archived: boolean } {
  if (taskExists(ctx.paths, id)) return { task: readTask(ctx.paths, id), archived: false };
  if (isArchived(ctx.paths, id)) return { task: readArchivedTask(ctx.paths, id), archived: true };
  throw new NotFoundError(`task "${id}" not found (run "agent-tasks list --all" to see every task)`);
}
