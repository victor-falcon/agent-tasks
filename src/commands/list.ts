import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { parseEnumList } from "../input.ts";
import { resolvePath } from "../paths.ts";
import type { RunStatus, Task } from "../schema.ts";
import { listArchivedTasks, listTasks } from "../store.ts";
import { runnerBanner } from "../output/banner.ts";
import { scheduleText } from "../output/schedule-text.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { paintMark, PENDING_MARK, RUN_MARKS, TASK_MARKS, type TaskMarkKind, taskMarkKind } from "../output/symbols.ts";
import { renderTable } from "../output/table.ts";
import { DAY, formatSpan, whenTime } from "../output/time.ts";
import { isInProgress } from "../run-info.ts";
import { describeSchedule, displayTimezone, TASK_STATES, type TaskState, taskOverview, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const WEEK_MS = 7 * DAY;
const DEFAULT_STATES: readonly TaskState[] = ["active", "paused"];

const HISTORY = 10;

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
  /** Start of the attempt in progress (running or blocked), if any. */
  active_since: string | null;
  /** `failed` + `timed_out` occurrences whose slot is in the last 7 days. */
  failed_7d: number;
  missed_7d: number;
}

function taskRow(ctx: Context, task: Task, archived: boolean): { row: TaskRow; errors: Error[] } {
  const overview = taskOverview(ctx, task, { archived, nextCount: 1 });
  const runs = overview.runs.map((r) => r.run); // oldest first
  const weekAgo = ctx.now.getTime() - WEEK_MS;
  const recent = runs.filter((r) => Date.parse(r.slot) >= weekAgo && Date.parse(r.slot) <= ctx.now.getTime());
  const count = (...statuses: RunStatus[]) => recent.filter((r) => statuses.includes(r.status)).length;
  const last = runs.at(-1);
  const statuses = runs.map((r) => r.status);
  const inProgress = runs.filter((r) => isInProgress(r.status)).at(-1);
  return {
    row: {
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
      active_since: inProgress?.attempts.at(-1)?.started_at ?? null,
      failed_7d: count("failed", "timed_out"),
      missed_7d: count("missed"),
    },
    errors: overview.errors,
  };
}

interface ListItem {
  row: TaskRow;
  task: Task;
}

function nextCell(style: Style, { row }: ListItem, now: Date, timezone: string): string {
  if (row.indicator === "running" || row.indicator === "blocked") {
    const since = row.active_since ? ` ${formatSpan(now.getTime() - Date.parse(row.active_since))}` : "";
    return style.paint(row.indicator === "running" ? "cyan" : "magenta", `${row.indicator}${since}`);
  }
  if (row.state === "paused") return style.paint("dim", "paused");
  if (row.state === "finished") return style.paint("dim", "done");
  if (row.state === "archived") return style.paint("dim", "archived");
  return row.next_run ? whenTime(new Date(row.next_run), timezone, now) : "—";
}

function historyCell(style: Style, { row }: ListItem): string {
  if (row.history.length === 0) return row.state === "active" ? paintMark(style, PENDING_MARK) : style.paint("dim", "—");
  return row.history.map((s) => paintMark(style, RUN_MARKS[s])).join("");
}

/** The task table: mark, id, schedule, next, last ${HISTORY} occurrences, folder. */
export function renderTaskList(items: readonly ListItem[], { style, now, timezone }: { style: Style; now: Date; timezone: string }): string {
  if (items.length === 0) return "No tasks. Create one with: agent-tasks add --title … --cron … --instructions …";
  return renderTable(
    [
      ["", "ID", "SCHEDULE", "NEXT", `LAST ${HISTORY}`, "FOLDER"],
      ...items.map((item) => [
        paintMark(style, TASK_MARKS[item.row.indicator]),
        item.row.id,
        scheduleText(item.task.schedule, timezone, now),
        nextCell(style, item, now, timezone),
        historyCell(style, item),
        item.row.cwd,
      ]),
    ],
    { style },
  );
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

const list: Command = {
  name: "list",
  summary: "List tasks with their next run and recent results",
  usage: `Usage: agent-tasks list [--status <state,…>] [--cwd <dir>] [--all]

Shows each task with its schedule, its next run and its last ${HISTORY}
occurrences, oldest first: ■ ok, ✕ failed or timed out, □ missed,
◐ running, ! blocked, - superseded or cancelled, · pending. The mark before
the id sums the task up: ● fine, ✕ its latest result failed, ◐ running,
! blocked (waiting for a person), ⏸ paused, ○ one-off still to run.
By default only active and paused tasks are listed. --json adds the 7-day
failed and missed counts.

Options:
  --status <states>  Only these states, comma-separated: ${TASK_STATES.join(", ")}
  --cwd <dir>        Only tasks whose working directory is <dir> or inside it
  --all              Include finished and archived tasks`,
  run(ctx, args) {
    const { values } = parseCommandArgs(args, { status: { type: "string" }, cwd: { type: "string" }, all: { type: "boolean" } }, { maxPositionals: 0 });
    const states = values.status !== undefined ? parseEnumList("--status", values.status, TASK_STATES) : values.all ? TASK_STATES : DEFAULT_STATES;
    const cwdFilter = values.cwd === undefined ? undefined : resolvePath(values.cwd, ctx.env, ctx.cwd);

    const tasks = listTasks(ctx.paths);
    const archived = states.includes("archived") ? listArchivedTasks(ctx.paths) : { items: [], errors: [] };
    const errors: Error[] = [...tasks.errors, ...archived.errors];
    const items: ListItem[] = [];
    const add = (task: Task, isArchived: boolean) => {
      if (cwdFilter !== undefined && !isInside(resolvePath(task.cwd, ctx.env, ctx.cwd), cwdFilter)) return;
      const { row, errors: runErrors } = taskRow(ctx, task, isArchived);
      errors.push(...runErrors);
      if (states.includes(row.state)) items.push({ row, task });
    };
    for (const task of tasks.items) add(task, false);
    for (const task of archived.items) add(task, true);
    items.sort((a, b) => a.row.id.localeCompare(b.row.id));

    runnerBanner(ctx);
    warnCorrupt(ctx, errors);
    output(ctx, { tasks: items.map((i) => i.row), errors: errors.map((e) => e.message) }, () =>
      renderTaskList(items, { style: stdoutStyle(ctx), now: ctx.now, timezone: displayTimezone(ctx) }),
    );
  },
};

export default list;
