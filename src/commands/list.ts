import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { parseEnumList } from "../input.ts";
import { resolvePath } from "../paths.ts";
import type { RunStatus, Task } from "../schema.ts";
import { listArchivedTasks, listTasks } from "../store.ts";
import { describeSchedule, TASK_STATES, type TaskState, table, taskOverview, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATES: readonly TaskState[] = ["active", "paused"];

export interface TaskRow {
  id: string;
  title: string;
  cwd: string;
  state: TaskState;
  schedule: string;
  /** In the task's time zone. */
  next_run: string | null;
  last_status: RunStatus | null;
  last_slot: string | null;
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
  return {
    row: {
      id: task.id,
      title: task.title,
      cwd: task.cwd,
      state: overview.state,
      schedule: describeSchedule(task),
      next_run: overview.next[0] ?? null,
      last_status: last?.status ?? null,
      last_slot: last?.slot ?? null,
      failed_7d: count("failed", "timed_out"),
      missed_7d: count("missed"),
    },
    errors: overview.errors,
  };
}

/** Plain aligned table. Kept apart so the phase-2 renderer can replace it. */
export function renderTaskList(rows: readonly TaskRow[]): string {
  if (rows.length === 0) return "No tasks.";
  return table([
    ["ID", "STATE", "NEXT RUN", "LAST", "FAILED 7D", "MISSED 7D", "SCHEDULE", "TITLE"],
    ...rows.map((r) => [r.id, r.state, r.next_run ?? "-", r.last_status ?? "-", String(r.failed_7d), String(r.missed_7d), r.schedule, r.title]),
  ]);
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

const list: Command = {
  name: "list",
  summary: "List tasks with their next run and recent results",
  usage: `Usage: agent-tasks list [--status <state,…>] [--cwd <dir>] [--all]

Shows each task with its next run, the status of its latest occurrence and
how many occurrences failed (failed or timed_out) or were missed in the
last 7 days. By default only active and paused tasks are listed.

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
    const rows: TaskRow[] = [];
    const add = (task: Task, isArchived: boolean) => {
      if (cwdFilter !== undefined && !isInside(resolvePath(task.cwd, ctx.env, ctx.cwd), cwdFilter)) return;
      const { row, errors: runErrors } = taskRow(ctx, task, isArchived);
      errors.push(...runErrors);
      if (states.includes(row.state)) rows.push(row);
    };
    for (const task of tasks.items) add(task, false);
    for (const task of archived.items) add(task, true);
    rows.sort((a, b) => a.id.localeCompare(b.id));

    warnCorrupt(ctx, errors);
    output(ctx, { tasks: rows, errors: errors.map((e) => e.message) }, () => renderTaskList(rows));
  },
};

export default list;
