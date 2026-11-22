import type { Resolution } from "../../../config.ts";
import type { Context } from "../../../context.ts";
import { formatAgent } from "../../../commands/show.ts";
import { scheduleText } from "../../../output/schedule-text.ts";
import { PENDING_MARK, RUN_MARKS, TASK_MARKS, type TaskMarkKind, taskMarkKind } from "../../../output/symbols.ts";
import { agendaTime, formatSpan, relativeTime, whenTime } from "../../../output/time.ts";
import { isInProgress } from "../../../run-info.ts";
import type { RunStatus, Task } from "../../../schema.ts";
import { listArchivedTasks, listTasks, type StoredRun } from "../../../store.ts";
import { type TaskState, taskOverview } from "../../../task-info.ts";
import { type Segment, truncate } from "../../components/cells.ts";
import { matchesQuery } from "../../components/filter.ts";
import type { ListSection } from "../../components/section-list.tsx";

// What the Tasks tab shows, as plain data so it is tested without a
// renderer: every task (archived ones too) read once per reload, the filters
// (state, machine, text) and sort orders, the rows of the table and the
// preview of the selection. The Task detail view reads the same items.

/** Next slots and past results a task shows (the strip and the preview's last runs). */
export const NEXT_SLOTS = 5;
export const LAST_RESULTS = 5;

export interface TaskItem {
  task: Task;
  archived: boolean;
  state: TaskState;
  /** The task at a glance (as `agent-tasks list` marks it). */
  mark: TaskMarkKind;
  resolution: Resolution;
  /** The next slots (ISO, in the task's time zone); none unless active. */
  next: string[];
  /** Every run, oldest first. */
  runs: StoredRun[];
  /** The last results, oldest first (superseded and cancelled slots left out). */
  strip: RunStatus[];
  /** The run in progress (running or blocked), if any, and since when. */
  active: { status: RunStatus; since: string | null } | null;
}

/** One task with what the views show of it; its unreadable run files go to `errors`. */
export function taskItem(ctx: Context, task: Task, archived: boolean, errors: Error[] = []): TaskItem {
  const overview = taskOverview(ctx, task, { archived, nextCount: NEXT_SLOTS });
  errors.push(...overview.errors);
  const statuses = overview.runs.map((r) => r.run.status);
  const inProgress = overview.runs.filter((r) => isInProgress(r.run.status)).at(-1);
  return {
    task,
    archived,
    state: overview.state,
    mark: taskMarkKind(overview.state, task.schedule.type === "once", statuses),
    resolution: overview.resolution,
    next: overview.next,
    runs: overview.runs,
    strip: statuses.filter((s) => s !== "superseded" && s !== "cancelled").slice(-LAST_RESULTS),
    active: inProgress ? { status: inProgress.run.status, since: inProgress.run.attempts.at(-1)?.started_at ?? null } : null,
  };
}

/** Reads every task, saved and archived, with what the table and the preview need. */
export function loadTaskItems(ctx: Context): { items: TaskItem[]; errors: Error[] } {
  const saved = listTasks(ctx.paths);
  const archived = listArchivedTasks(ctx.paths);
  const errors: Error[] = [...saved.errors, ...archived.errors];
  // An id saved and archived at once (restored by hand, then archived again) shows once: the saved one.
  const ids = new Set(saved.items.map((t) => t.id));
  return {
    items: [...saved.items.map((t) => taskItem(ctx, t, false, errors)), ...archived.items.filter((t) => !ids.has(t.id)).map((t) => taskItem(ctx, t, true, errors))],
    errors,
  };
}

// ---------------------------------------------------------------------------
// Filters and sort
// ---------------------------------------------------------------------------

/** `f` cycles these. `all` is every task, finished and archived ones included. */
export const STATE_FILTERS = ["all", "active", "paused", "archived"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

/** `s` cycles these: the next run first, by id, or the worst latest result first. */
export const SORTS = ["next", "id", "last"] as const;
export type Sort = (typeof SORTS)[number];

export const SORT_LABELS: Record<Sort, string> = { next: "next run", id: "id", last: "last result" };

export interface TaskFilter {
  state: StateFilter;
  /** Only tasks of this machine; null for all. */
  machine: string | null;
  /** The `/` text, over id, title, description, folder and machine. */
  query: string;
}

export function cycle<T>(values: readonly T[], current: T): T {
  return values[(values.indexOf(current) + 1) % values.length]!;
}

/** The machines tasks run on, sorted: what `m` cycles through (after "all"). */
export function machinesOf(items: readonly TaskItem[]): string[] {
  return [...new Set(items.map((i) => i.task.machine))].sort();
}

/** The next machine filter after `current`: all, then each machine, then all again. */
export function nextMachine(items: readonly TaskItem[], current: string | null): string | null {
  const machines = machinesOf(items);
  if (machines.length === 0) return null;
  if (current === null) return machines[0]!;
  const at = machines.indexOf(current);
  return at === -1 || at === machines.length - 1 ? null : machines[at + 1]!;
}

function stateMatches(item: TaskItem, state: StateFilter): boolean {
  if (state === "all") return true;
  if (state === "archived") return item.archived;
  return item.state === state;
}

export function filterTasks(items: readonly TaskItem[], filter: TaskFilter): TaskItem[] {
  return items.filter(
    (i) =>
      stateMatches(i, filter.state) &&
      (filter.machine === null || i.task.machine === filter.machine) &&
      matchesQuery(filter.query, [i.task.id, i.task.title, i.task.description, i.task.cwd, i.task.machine]),
  );
}

/** Worst first, for the "last result" sort: what needs you, then what runs, then the rest. */
const MARK_RANK: Record<TaskMarkKind, number> = { blocked: 0, failing: 1, running: 2, ok: 3, once_pending: 4, paused: 5, finished: 6, archived: 7 };

const lastAt = (i: TaskItem) => (i.runs.length > 0 ? Date.parse(i.runs.at(-1)!.run.slot) : 0);

export function sortTasks(items: readonly TaskItem[], sort: Sort): TaskItem[] {
  const byId = (a: TaskItem, b: TaskItem) => a.task.id.localeCompare(b.task.id);
  const compare: Record<Sort, (a: TaskItem, b: TaskItem) => number> = {
    id: byId,
    // Tasks without a next run (paused, finished, archived) after the others.
    next: (a, b) => {
      const [x, y] = [a.next[0], b.next[0]];
      if (x && y) return Date.parse(x) - Date.parse(y) || byId(a, b);
      return x ? -1 : y ? 1 : byId(a, b);
    },
    last: (a, b) => MARK_RANK[a.mark] - MARK_RANK[b.mark] || lastAt(b) - lastAt(a) || byId(a, b),
  };
  return [...items].sort(compare[sort]);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface TableInput {
  now: Date;
  /** The display time zone (for one-off schedules). */
  timezone: string;
  /** Whether a machine column is shown (see showMachineColumn). */
  showMachine: boolean;
  /** The title column: left out next to the preview (which has it) and on a narrow terminal. */
  showTitle: boolean;
  /** The folder column: left out on a narrow terminal (under 80 columns). */
  showFolder: boolean;
}

/** Longest title shown in the table (the preview has it whole). */
const TITLE_WIDTH = 28;

const rowKey = (item: TaskItem) => `${item.archived ? "archived" : "tasks"}:${item.task.id}`;

/** A row key (`tasks:<id>`, `runs:<ref>`) → the task id or run ref it stands for. */
export function idOfKey(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

export function stripCell(item: Pick<TaskItem, "strip" | "state">): Segment {
  if (item.strip.length === 0) return item.state === "active" ? { text: PENDING_MARK.symbol, color: PENDING_MARK.color } : { text: "–", color: "dim" };
  const parts = item.strip.map((s) => ({ text: RUN_MARKS[s].symbol, color: RUN_MARKS[s].color }));
  return { text: parts.map((p) => p.text).join(""), parts };
}

function nextCell(item: TaskItem, { now, timezone }: TableInput): Segment {
  if (item.active) {
    const since = item.active.since ? ` ${formatSpan(now.getTime() - Date.parse(item.active.since))}` : "";
    // Its mark says it runs: say it is paused too, or nothing would.
    const paused = item.state === "paused" ? " · paused" : "";
    return { text: `${item.active.status}${since}${paused}`, color: RUN_MARKS[item.active.status].color };
  }
  if (item.archived) return { text: "archived", color: "dim" };
  if (item.state === "paused") return { text: "paused", color: "dim" };
  if (item.state === "finished") return { text: "done", color: "dim" };
  return item.next[0] ? { text: whenTime(new Date(item.next[0]), timezone, now) } : { text: "–", color: "dim" };
}

function cut(text: string, width: number): string {
  return Bun.stringWidth(text) <= width ? text : `${truncate(text, width - 1)}…`;
}

export function taskCells(item: TaskItem, input: TableInput): Segment[] {
  const mark = TASK_MARKS[item.mark];
  const quiet = item.archived || item.state === "paused" || item.state === "finished";
  return [
    { text: mark.symbol, color: mark.color },
    { text: item.task.id, color: quiet ? "dim" : undefined },
    ...(input.showTitle ? [{ text: cut(item.task.title, TITLE_WIDTH), color: "dim" as const }] : []),
    { text: scheduleText(item.task.schedule, input.timezone, input.now) },
    nextCell(item, input),
    stripCell(item),
    ...(input.showMachine ? [{ text: item.task.machine, color: "dim" as const }] : []),
    ...(input.showFolder ? [{ text: item.task.cwd, color: "dim" as const }] : []),
  ];
}

/**
 * The table's sections: the saved tasks, then the archived ones (only with
 * a state filter that shows them). `filtered`: a text or machine filter is
 * on, so an empty section says the filters hide the tasks, not that there
 * are none.
 */
export function taskSections(items: readonly TaskItem[], state: StateFilter, input: TableInput, filtered = false): ListSection[] {
  const rows = (list: readonly TaskItem[]) => list.map((i) => ({ key: rowKey(i), cells: taskCells(i, input) }));
  const none = (what: string) => (filtered ? `no ${what} match the filters` : `no ${what}`);
  const sections: ListSection[] = [];
  if (state !== "archived") {
    const empty = state === "all" && !filtered ? "no tasks yet: ask an agent to schedule one" : none(state === "all" ? "tasks" : `${state} tasks`);
    sections.push({ id: "tasks", title: state === "all" ? "Tasks" : `Tasks · ${state}`, rows: rows(items.filter((i) => !i.archived)), empty });
  }
  if (state === "all" || state === "archived") sections.push({ id: "archived", title: "Archived", rows: rows(items.filter((i) => i.archived)), empty: state === "archived" ? none("archived tasks") : null });
  return sections;
}

/** `◐ Sentry summary · sentry-summary · active`: the head of the preview and of the Task detail. */
export function titleSegments(item: TaskItem): Segment[] {
  const mark = TASK_MARKS[item.mark];
  return [{ text: `${mark.symbol} `, color: mark.color }, { text: item.task.title, color: "bold" }, { text: ` · ${item.task.id} · ${item.state}`, color: "dim" }];
}

/** The next slots as lines (`  11:00  in 58m`), or why there are none. */
export function nextRunLines(item: Pick<TaskItem, "next" | "state">, now: Date, timezone: string): Segment[][] {
  if (item.next.length === 0) return [[{ text: `  none (${item.state})`, color: "dim" }]];
  return item.next.map((slot) => [{ text: `  ${agendaTime(new Date(slot), timezone, now)}` }, { text: `  ${relativeTime(new Date(slot), now)}`, color: "dim" }]);
}

// ---------------------------------------------------------------------------
// Settings in a few words (the preview, and the Task detail's Overview)
// ---------------------------------------------------------------------------

/** `agent`, `timeout`, `retries`, `keep open`: what a run of the task gets. */
export function settingsSummary(r: Resolution): { label: string; value: string }[] {
  return [
    { label: "Agent", value: formatAgent(r.agent) },
    { label: "Timeout", value: r.timeout },
    { label: "Retries", value: String(r.retries) },
    { label: "Keep open", value: r.keep_open },
  ];
}

// ---------------------------------------------------------------------------
// A task's runs (the preview's last runs, the Task detail's Runs)
// ---------------------------------------------------------------------------

/** One run of a task as a row: mark, slot, status, how long it took, attempts, summary or reason. */
export function runCells(stored: StoredRun, now: Date, timezone: string): Segment[] {
  const { run } = stored;
  const mark = RUN_MARKS[run.status];
  const last = run.attempts.at(-1);
  const started = run.attempts[0]?.started_at;
  const took = started ? formatSpan((last?.finished_at ? Date.parse(last.finished_at) : now.getTime()) - Date.parse(started)) : "–";
  const summary = last?.summary?.split("\n")[0];
  return [
    { text: mark.symbol, color: mark.color },
    { text: agendaTime(new Date(run.slot), timezone, now) },
    { text: run.status === "succeeded" ? "ok" : run.status.replace("_", " "), color: mark.color },
    { text: took, color: "dim" },
    { text: run.attempts.length > 1 ? `×${run.attempts.length}` : "" },
    summary ? { text: summary } : { text: run.reason?.split("\n")[0] ?? "", color: "dim" },
  ];
}
