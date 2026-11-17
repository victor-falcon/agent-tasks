import type { Context } from "./context.ts";
import type { Style } from "./output/style.ts";
import { paintMark, PENDING_MARK, RUN_MARKS, type TaskMarkKind, taskMarkKind } from "./output/symbols.ts";
import { DAY } from "./output/time.ts";
import { isDecisive, isFailure, isInProgress } from "./run-info.ts";
import type { RunStatus, Task } from "./schema.ts";
import { describeSchedule, type TaskOverview, type TaskState, taskOverview } from "./task-info.ts";

// One task at a glance, as `list` and the runner's Tasks panel show it.

const WEEK_MS = 7 * DAY;
/** How many past occurrences the history strip shows. */
export const HISTORY = 10;

export interface TaskRow {
  id: string;
  title: string;
  cwd: string;
  state: TaskState;
  /** The task at a glance: ok, running, blocked, failing, paused, once_pending, finished, archived. */
  indicator: TaskMarkKind;
  schedule: string;
  /** In the task's time zone. */
  next_run: string | null;
  last_status: RunStatus | null;
  last_slot: string | null;
  /** Statuses of the last ${HISTORY} occurrences, oldest first. */
  history: RunStatus[];
  /** Status and start of the latest attempt in progress (running or blocked), if any. */
  in_progress: RunStatus | null;
  active_since: string | null;
  /** Whether the latest decisive result (ok, failed, timed out) is a failure. */
  failing: boolean;
  /** `failed` + `timed_out` occurrences whose slot is in the last 7 days. */
  failed_7d: number;
  missed_7d: number;
}

/** The row of a task from its overview (runs oldest first). */
export function taskRowFromOverview(overview: TaskOverview, now: Date): TaskRow {
  const { task } = overview;
  const runs = overview.runs.map((r) => r.run); // oldest first
  const weekAgo = now.getTime() - WEEK_MS;
  const recent = runs.filter((r) => Date.parse(r.slot) >= weekAgo && Date.parse(r.slot) <= now.getTime());
  const count = (...statuses: RunStatus[]) => recent.filter((r) => statuses.includes(r.status)).length;
  const last = runs.at(-1);
  const statuses = runs.map((r) => r.status);
  const inProgress = runs.filter((r) => isInProgress(r.status)).at(-1);
  const decisive = runs.filter((r) => isDecisive(r.status)).at(-1);
  return {
    id: task.id,
    title: task.title,
    cwd: task.cwd,
    state: overview.state,
    indicator: taskMarkKind(overview.state, task.schedule.type === "once", statuses),
    schedule: describeSchedule(task),
    next_run: overview.next[0] ?? null,
    last_status: last?.status ?? null,
    last_slot: last?.slot ?? null,
    history: statuses.slice(-HISTORY),
    in_progress: inProgress?.status ?? null,
    active_since: inProgress?.attempts.at(-1)?.started_at ?? null,
    failing: decisive !== undefined && isFailure(decisive.status),
    failed_7d: count("failed", "timed_out"),
    missed_7d: count("missed"),
  };
}

export function taskRow(ctx: Context, task: Task, archived: boolean): { row: TaskRow; errors: Error[] } {
  const overview = taskOverview(ctx, task, { archived, nextCount: 1 });
  return { row: taskRowFromOverview(overview, ctx.now), errors: overview.errors };
}

/** The last ${HISTORY} occurrences as marks, oldest first: `■■□✕`, `·` for an active task with none yet. */
export function historyStrip(style: Style, row: Pick<TaskRow, "history" | "state">): string {
  if (row.history.length === 0) return row.state === "active" ? paintMark(style, PENDING_MARK) : style.paint("dim", "—");
  return row.history.map((s) => paintMark(style, RUN_MARKS[s])).join("");
}
