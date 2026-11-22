import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { Context } from "./context.ts";
import { scheduleText } from "./output/schedule-text.ts";
import { sameDay } from "./output/time.ts";
import { isFailure, isInProgress, lastActivity } from "./run-info.ts";
import { contextRunnerHealth, type RunnerHealth } from "./runner-health.ts";
import { runnerLogPath } from "./runner-lock.ts";
import type { RunStatus } from "./schema.ts";
import { listRuns, listTasks, type StoredRun, taskIdsWithRuns } from "./store.ts";
import { displayTimezone, taskOverview } from "./task-info.ts";

// What the dashboard shows, read from the data folder in one go: the runner's
// health, runs in progress, what comes next, recent results and the tail of
// runner.log. `agent-tasks top --json` prints it as it is.

/** Finished runs kept for the Recent panel. */
export const RECENT_LIMIT = 100;
/** Lines of runner.log kept for the Events panel. */
export const EVENT_LINES = 200;

/** Slots that were skipped on purpose (a newer slot ran instead, or the task was paused): not results. */
const HIDDEN: readonly RunStatus[] = ["superseded", "cancelled"];

export interface DashRun {
  ref: string;
  task_id: string;
  status: RunStatus;
  slot: string;
  /** Number of the latest attempt (0: it never started). */
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  /** When it last changed: what Recent sorts by. */
  at: string;
  summary: string | null;
  reason: string | null;
  /** The launcher's handle of the latest attempt (`t45`, a tmux window…). */
  handle: string | null;
  machine: string | null;
}

export interface DashNext {
  task_id: string;
  title: string;
  /** Next slot, or null for a paused task. */
  at: string | null;
  state: "active" | "paused";
  schedule: string;
  machine: string;
}

export interface Dashboard {
  now: string;
  /** The resolved data folder: what a UI watches to know when to ask again. */
  data_dir: string;
  runner: RunnerHealth;
  running: DashRun[];
  next: DashNext[];
  /** Finished runs, newest first (superseded and cancelled slots left out). */
  recent: DashRun[];
  /** Results whose last change is today (display time zone); `blocked` counts runs blocked right now. */
  today: { succeeded: number; failed: number; missed: number; blocked: number };
  /** The last lines of `state/runner.log`. */
  events: string[];
  errors: string[];
}

/** A run as a dashboard row; `machine` is the task's, for a run that never started a session. */
export function dashRun({ ref, run }: Pick<StoredRun, "ref" | "run">, machine: string | null): DashRun {
  const last = run.attempts.at(-1);
  return {
    ref,
    task_id: run.task_id,
    status: run.status,
    slot: run.slot,
    attempt: last?.n ?? 0,
    started_at: last?.started_at ?? null,
    finished_at: last?.finished_at ?? null,
    at: lastActivity(run),
    summary: last?.summary ?? null,
    reason: last?.reason ?? run.reason ?? null,
    handle: last?.session?.handle ?? null,
    machine: last?.session?.machine ?? machine,
  };
}

/** The last `count` lines of a file, reading only its end. */
export function tailLines(path: string, count: number, maxBytes = 64 * 1024): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // the first line may be cut
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

export function buildDashboard(ctx: Context): Dashboard {
  const tz = displayTimezone(ctx);
  const tasks = listTasks(ctx.paths);
  const errors: Error[] = [...tasks.errors];
  const saved = new Map(tasks.items.map((t) => [t.id, t]));
  const ids = [...new Set([...saved.keys(), ...taskIdsWithRuns(ctx.paths)])].sort();

  const running: DashRun[] = [];
  const recent: DashRun[] = [];
  const next: DashNext[] = [];
  for (const id of ids) {
    const task = saved.get(id);
    let runs: StoredRun[];
    if (task) {
      const overview = taskOverview(ctx, task, { nextCount: 1 });
      errors.push(...overview.errors);
      runs = overview.runs;
      const schedule = scheduleText(task.schedule, overview.resolution.timezone, ctx.now);
      if (overview.state === "active" && overview.next[0]) next.push({ task_id: id, title: task.title, at: overview.next[0], state: "active", schedule, machine: task.machine });
      else if (overview.state === "paused") next.push({ task_id: id, title: task.title, at: null, state: "paused", schedule, machine: task.machine });
    } else {
      const result = listRuns(ctx.paths, id); // removed or archived: its runs still count
      errors.push(...result.errors);
      runs = result.items;
    }
    for (const stored of runs) {
      if (HIDDEN.includes(stored.run.status)) continue;
      (isInProgress(stored.run.status) ? running : recent).push(dashRun(stored, task?.machine ?? null));
    }
  }

  const byTime = (a: { at: string | null }, b: { at: string | null }) => (a.at === null ? 1 : b.at === null ? -1 : Date.parse(a.at) - Date.parse(b.at));
  running.sort((a, b) => Date.parse(a.started_at ?? a.slot) - Date.parse(b.started_at ?? b.slot));
  next.sort((a, b) => byTime(a, b) || a.task_id.localeCompare(b.task_id));
  recent.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.ref.localeCompare(a.ref));

  const today = { succeeded: 0, failed: 0, missed: 0, blocked: running.filter((r) => r.status === "blocked").length };
  for (const r of recent) {
    if (!sameDay(new Date(r.at), ctx.now, tz)) continue;
    if (r.status === "succeeded") today.succeeded++;
    else if (isFailure(r.status)) today.failed++;
    else if (r.status === "missed") today.missed++;
  }

  return {
    now: ctx.now.toISOString(),
    data_dir: ctx.paths.dataDir,
    runner: contextRunnerHealth(ctx),
    running,
    next,
    recent: recent.slice(0, RECENT_LIMIT),
    today,
    events: tailLines(runnerLogPath(ctx.paths), EVENT_LINES),
    errors: errors.map((e) => e.message),
  };
}
