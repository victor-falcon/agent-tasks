import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { parseEnumList } from "../input.ts";
import { resolvePath } from "../paths.ts";
import type { Task } from "../schema.ts";
import { listArchivedTasks, listTasks } from "../store.ts";
import { runnerBanner } from "../output/banner.ts";
import { scheduleText } from "../output/schedule-text.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { paintMark, TASK_MARKS } from "../output/symbols.ts";
import { renderTable } from "../output/table.ts";
import { formatSpan, whenTime } from "../output/time.ts";
import { displayTimezone, TASK_STATES, type TaskState, warnCorrupt } from "../task-info.ts";
import { HISTORY, historyStrip, type TaskRow, taskRow } from "../task-row.ts";
import type { Command } from "./types.ts";

const DEFAULT_STATES: readonly TaskState[] = ["active", "paused"];
/** `--status` values about results rather than the task state. */
const RESULT_FILTERS = ["failed", "running", "blocked"] as const;
type ResultFilter = (typeof RESULT_FILTERS)[number];
const STATUS_FILTERS = [...TASK_STATES, ...RESULT_FILTERS] as const;

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
        historyStrip(style, item.row),
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
  usage: `Usage: agent-tasks list [--status <filter,…>] [--cwd <dir>] [--all]

Shows each task with its schedule, its next run and its last ${HISTORY}
occurrences, oldest first: ■ ok, ✕ failed or timed out, □ missed,
◐ running, ! blocked, - superseded or cancelled, · pending. The mark before
the id sums the task up: ● fine, ✕ its latest result failed, ◐ running,
! blocked (waiting for a person), ⏸ paused, ○ one-off still to run.
By default only active and paused tasks are listed. --json adds the 7-day
failed and missed counts.

Options:
  --status <filters>  Comma-separated. Task states: ${TASK_STATES.join(", ")}.
                     Results: failed (latest result failed or timed out),
                     running, blocked. Values of one kind add up; the two
                     kinds combine (paused,failed: paused tasks that fail)
  --cwd <dir>         Only tasks whose working directory is <dir> or inside it
  --all               Include finished and archived tasks`,
  run(ctx, args) {
    const { values } = parseCommandArgs(args, { status: { type: "string" }, cwd: { type: "string" }, all: { type: "boolean" } }, { maxPositionals: 0 });
    const filters = values.status === undefined ? [] : parseEnumList("--status", values.status, STATUS_FILTERS);
    const results = filters.filter((f): f is ResultFilter => (RESULT_FILTERS as readonly string[]).includes(f));
    const chosenStates = filters.filter((f): f is TaskState => (TASK_STATES as readonly string[]).includes(f));
    const states = chosenStates.length > 0 ? chosenStates : values.all ? TASK_STATES : DEFAULT_STATES;
    const resultMatches = (row: TaskRow) => results.length === 0 || results.some((f) => (f === "failed" ? row.failing : row.in_progress === f));
    const cwdFilter = values.cwd === undefined ? undefined : resolvePath(values.cwd, ctx.env, ctx.cwd);

    const tasks = listTasks(ctx.paths);
    const archived = states.includes("archived") ? listArchivedTasks(ctx.paths) : { items: [], errors: [] };
    const errors: Error[] = [...tasks.errors, ...archived.errors];
    const items: ListItem[] = [];
    const add = (task: Task, isArchived: boolean) => {
      if (cwdFilter !== undefined && !isInside(resolvePath(task.cwd, ctx.env, ctx.cwd), cwdFilter)) return;
      const { row, errors: runErrors } = taskRow(ctx, task, isArchived);
      errors.push(...runErrors);
      if (states.includes(row.state) && resultMatches(row)) items.push({ row, task });
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
