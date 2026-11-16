import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { UsageError } from "../errors.ts";
import { resolvePath } from "../paths.ts";
import type { RunStatus, Task } from "../schema.ts";
import { listArchivedTasks, listRuns, listTasks } from "../store.ts";
import { nextRuns, TASK_STATES, type TaskState, table, taskState, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_STATES: readonly TaskState[] = ["active", "paused"];

export interface TaskRow {
  id: string;
  title: string;
  cwd: string;
  state: TaskState;
  schedule: string;
  next_run: string | null;
  last_status: RunStatus | null;
  last_slot: string | null;
  /** `failed` + `timed_out` occurrences whose slot is in the last 7 days. */
  failed_7d: number;
  missed_7d: number;
}

function describeSchedule(task: Task): string {
  const s = task.schedule;
  return s.type === "once" ? `once ${s.at}` : `cron ${s.cron}${s.timezone ? ` (${s.timezone})` : ""}`;
}

function taskRow(ctx: Context, task: Task, archived: boolean): { row: TaskRow; errors: Error[] } {
  const runs = listRuns(ctx.paths, task.id);
  const stored = runs.items.map((r) => r.run);
  const state = taskState(task, stored, archived);
  const resolution = ctx.resolveFor(task);
  const weekAgo = ctx.now.getTime() - WEEK_MS;
  const recent = stored.filter((r) => Date.parse(r.slot) >= weekAgo && Date.parse(r.slot) <= ctx.now.getTime());
  const last = stored.at(-1);
  return {
    row: {
      id: task.id,
      title: task.title,
      cwd: task.cwd,
      state,
      schedule: describeSchedule(task),
      next_run: nextRuns(task, state, resolution, ctx.now, 1)[0] ?? null,
      last_status: last?.status ?? null,
      last_slot: last?.slot ?? null,
      failed_7d: recent.filter((r) => r.status === "failed" || r.status === "timed_out").length,
      missed_7d: recent.filter((r) => r.status === "missed").length,
    },
    errors: runs.errors,
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
    let states: readonly TaskState[] = values.all ? TASK_STATES : DEFAULT_STATES;
    if (values.status !== undefined) {
      const wanted = values.status.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = wanted.filter((s) => !(TASK_STATES as readonly string[]).includes(s));
      if (bad.length > 0 || wanted.length === 0) throw new UsageError(`--status: unknown state "${bad[0] ?? ""}" (states: ${TASK_STATES.join(", ")})`);
      states = wanted as TaskState[];
    }
    const cwdFilter = values.cwd === undefined ? undefined : resolvePath(values.cwd, ctx.env, ctx.cwd);

    const tasks = listTasks(ctx.paths);
    const archived = states.includes("archived") ? listArchivedTasks(ctx.paths) : { items: [], errors: [] };
    const errors: Error[] = [...tasks.errors, ...archived.errors];
    const rows: TaskRow[] = [];
    for (const [task, isArchivedTask] of [...tasks.items.map((t) => [t, false] as const), ...archived.items.map((t) => [t, true] as const)]) {
      if (cwdFilter !== undefined && !isInside(resolvePath(task.cwd, ctx.env, ctx.cwd), cwdFilter)) continue;
      const { row, errors: runErrors } = taskRow(ctx, task, isArchivedTask);
      errors.push(...runErrors);
      if (states.includes(row.state)) rows.push(row);
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));

    warnCorrupt(ctx, errors);
    output(ctx, { tasks: rows, errors: errors.map((e) => e.message) }, () => renderTaskList(rows));
  },
};

export default list;
