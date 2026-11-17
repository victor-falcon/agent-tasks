import { formatAgent, formatLauncher } from "../commands/show.ts";
import type { Context } from "../context.ts";
import { scheduleText } from "../output/schedule-text.ts";
import type { Run, Task } from "../schema.ts";
import { listRuns, listTasks, type StoredRun, taskIdsWithRuns } from "../store.ts";
import { displayTimezone, describeSchedule, type TaskState, taskOverview } from "../task-info.ts";
import { type TaskRow, taskRowFromOverview } from "../task-row.ts";

// What the runner's view shows, read from the data folder in one pass. The
// renderer only formats it, so it can be tested without files.

/** Runs kept for the Recent panel, newest slot first. */
export const RECENT_LIMIT = 100;
/** Upcoming slots per task, and in total. */
const NEXT_PER_TASK = 3;
const UPCOMING_LIMIT = 30;
/** Runs listed in a task's detail. */
const TASK_RECENT_RUNS = 5;

export interface RecentItem {
  ref: string;
  task_id: string;
  run: Run;
  /** The task's folder, when the task still exists. */
  cwd: string | null;
  /** Attempts allowed (`retries + 1`), when the task still exists. */
  max_attempts: number | null;
}

export interface UpcomingItem {
  task_id: string;
  /** ISO time of the slot. */
  at: string;
  schedule: string;
}

export interface TaskItem {
  task: Task;
  state: TaskState;
  row: TaskRow;
  /** `every day 08:00` and `cron "0 8 * * *" in …`. */
  schedule: string;
  schedule_detail: string;
  timezone: string;
  agent: string;
  launcher: string;
  timeout: string;
  retries: number;
  catch_up: string;
  next: string[];
  /** The latest runs, newest first. */
  recent: StoredRun[];
}

export interface TuiData {
  recent: RecentItem[];
  upcoming: UpcomingItem[];
  tasks: TaskItem[];
  /** Files that could not be read. */
  errors: string[];
  /** Display time zone (config, else system). */
  timezone: string;
  /** False until the data folder was read once. */
  loaded: boolean;
}

export function emptyData(): TuiData {
  return { recent: [], upcoming: [], tasks: [], errors: [], timezone: "UTC", loaded: false };
}

export function loadData(ctx: Context): TuiData {
  const tasks = listTasks(ctx.paths);
  const errors: string[] = tasks.errors.map((e) => e.message);
  const known = new Set(tasks.items.map((t) => t.id));
  const recent: RecentItem[] = [];
  const upcoming: UpcomingItem[] = [];
  const items: TaskItem[] = [];

  for (const task of tasks.items) {
    const overview = taskOverview(ctx, task, { nextCount: NEXT_PER_TASK });
    errors.push(...overview.errors.map((e) => e.message));
    const { resolution } = overview;
    const schedule = scheduleText(task.schedule, resolution.timezone, ctx.now);
    for (const at of overview.next) upcoming.push({ task_id: task.id, at, schedule });
    for (const { ref, run } of overview.runs) recent.push({ ref, task_id: task.id, run, cwd: task.cwd, max_attempts: resolution.retries + 1 });
    items.push({
      task,
      state: overview.state,
      row: taskRowFromOverview(overview, ctx.now),
      schedule,
      schedule_detail: describeSchedule(task),
      timezone: resolution.timezone,
      agent: formatAgent(resolution.agent),
      launcher: formatLauncher(resolution.launcher),
      timeout: resolution.timeout,
      retries: resolution.retries,
      catch_up: resolution.catch_up,
      next: overview.next,
      recent: overview.runs.slice(-TASK_RECENT_RUNS).reverse(),
    });
  }
  // Removed or archived tasks: their runs still belong in Recent.
  for (const id of taskIdsWithRuns(ctx.paths)) {
    if (known.has(id)) continue;
    const runs = listRuns(ctx.paths, id);
    errors.push(...runs.errors.map((e) => e.message));
    for (const { ref, run } of runs.items) recent.push({ ref, task_id: id, run, cwd: null, max_attempts: null });
  }

  recent.sort((a, b) => Date.parse(b.run.slot) - Date.parse(a.run.slot) || b.ref.localeCompare(a.ref));
  upcoming.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.task_id.localeCompare(b.task_id));
  items.sort((a, b) => a.task.id.localeCompare(b.task.id));
  return {
    recent: recent.slice(0, RECENT_LIMIT),
    upcoming: upcoming.slice(0, UPCOMING_LIMIT),
    tasks: items,
    errors,
    timezone: displayTimezone(ctx),
    loaded: true,
  };
}
