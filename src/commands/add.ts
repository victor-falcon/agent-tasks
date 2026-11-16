import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { AgentTasksError, UsageError, ValidationError } from "../errors.ts";
import { TASK_ID_RE, type Task, taskErrors } from "../schema.ts";
import { createJsonExclusive, isArchived, taskExists, taskPath } from "../store.ts";
import { applyTaskFlags, completeTask, displayPath, nowIso, normalizeTaskCwd, parseJsonObject, readStdin, TASK_FLAG_OPTIONS, TASK_FLAGS_USAGE } from "../task-flags.ts";
import { nextRuns } from "../task-info.ts";
import type { Command } from "./types.ts";

const MAX_ID = 64;

/** `Weekly deps report!` → `weekly-deps-report`. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID - 4)
    .replace(/-+$/, "");
  return slug || "task";
}

const add: Command = {
  name: "add",
  summary: "Create a task",
  usage: `Usage: agent-tasks add --title <text> (--at <iso> | --cron <expr>) (--instructions <text> | --instructions-file <path|->) [options]
       agent-tasks add --json-input < task.json
       agent-tasks add - < task.json

Creates a task from flags, or from a task JSON on stdin (flags given as well
override its fields). Fills in id, created_at, updated_at and created_by,
validates it, checks that cwd exists and shows the next 3 runs.

Options:
${TASK_FLAGS_USAGE}
  --id <slug>                 Use this id instead of one derived from the title
  --json-input                Read the task JSON from stdin (same as "-")

Without --id, the id is a slug of the title; a numeric suffix is added when
it is taken (by a task or an archived one). --cwd defaults to the current
folder. With --json, prints the task and its next runs.`,
  async run(ctx, args) {
    const { values, positionals } = parseCommandArgs(
      args,
      { ...TASK_FLAG_OPTIONS, id: { type: "string" }, "json-input": { type: "boolean" } },
      { maxPositionals: 1 },
    );
    if (positionals[0] !== undefined && positionals[0] !== "-") throw new UsageError(`unexpected argument "${positionals[0]}"`);
    const fromStdin = values["json-input"] === true || positionals[0] === "-";
    if (fromStdin && values["instructions-file"] === "-") throw new UsageError("stdin can hold the task JSON or the instructions, not both");

    const task: Partial<Task> = fromStdin ? (parseJsonObject(await readStdin(), "the task on stdin") as Partial<Task>) : {};
    if (!fromStdin && values.at === undefined && values.cron === undefined) throw new UsageError("add needs --at <iso> or --cron <expr>");
    await applyTaskFlags(ctx, task, values);

    const now = nowIso(ctx);
    task.cwd = normalizeTaskCwd(ctx, task.cwd ?? ctx.cwd);
    task.enabled ??= true;
    task.created_at = now;
    task.updated_at = now;
    task.created_by = { cwd: displayPath(ctx, ctx.cwd), session: ctx.env.HC_TERMINAL_ID || null };
    task.schedule_since = null;

    const explicitId = values.id ?? task.id;
    // Validate with a placeholder id first, so field errors are reported before id errors.
    const errors = taskErrors({ ...task, id: explicitId ?? "placeholder" });
    if (errors.length > 0) throw new ValidationError("task", errors);

    const created = explicitId !== undefined ? createWithId(ctx, task, explicitId) : createFromTitle(ctx, task);
    if (created.schedule.type === "once" && Date.parse(created.schedule.at) <= ctx.now.getTime() && !ctx.json) {
      ctx.stderr.write(`warning: --at ${created.schedule.at} is not in the future; the next tick runs it if it is within max_delay, otherwise it is missed\n`);
    }

    const resolution = ctx.resolveFor(created);
    const next = nextRuns(created, "active", resolution, ctx.now, 3);
    output(ctx, { task: created, next_runs: next }, () =>
      [
        `Created task ${created.id}`,
        `  file: ${taskPath(ctx.paths, created.id)}`,
        next.length > 0 ? `Next runs (${resolution.timezone}):\n${next.map((t) => `  ${t}`).join("\n")}` : "No upcoming runs.",
      ].join("\n"),
    );
  },
};

function createWithId(ctx: Parameters<Command["run"]>[0], task: Partial<Task>, id: string): Task {
  if (!TASK_ID_RE.test(id)) throw new UsageError(`invalid task id "${id}" (lowercase letters, digits and dashes, max 64 chars)`);
  if (isArchived(ctx.paths, id)) throw new AgentTasksError("conflict", `task id "${id}" belongs to an archived task; pick another id`);
  const full = completeTask({ ...task, id });
  if (!createJsonExclusive(taskPath(ctx.paths, id), full)) throw new AgentTasksError("conflict", `task "${id}" already exists`);
  return full;
}

function createFromTitle(ctx: Parameters<Command["run"]>[0], task: Partial<Task>): Task {
  const base = slugify(task.title!);
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (taskExists(ctx.paths, id) || isArchived(ctx.paths, id)) continue;
    const full = completeTask({ ...task, id });
    // Exclusive create: two concurrent `add`s with the same title get different ids.
    if (createJsonExclusive(taskPath(ctx.paths, id), full)) return full;
  }
  throw new AgentTasksError("conflict", `could not find a free id for "${base}"`);
}

export default add;
