import { parseCommandArgs } from "../args.ts";
import { localMachine } from "../config.ts";
import { output } from "../context.ts";
import { UsageError, ValidationError } from "../errors.ts";
import { parseJsonObject, readStdin } from "../input.ts";
import { type Task, taskErrors } from "../schema.ts";
import { taskPath } from "../store.ts";
import { applyTaskFlags, checkTaskMachine, displayPath, normalizeTaskCwd, TASK_FLAG_OPTIONS, TASK_FLAGS_USAGE } from "../task-flags.ts";
import { createTaskFromTitle, createTaskWithId } from "../task-id.ts";
import { describeNext, nowIso, taskOverview } from "../task-info.ts";
import type { Command } from "./types.ts";

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
it is taken (by a task, an archived task or old run history). --cwd
defaults to the current folder, --machine to this machine (\`machine\` in
the config, or "local"); another machine must be in the config's
\`machines\`. With --json, prints the task and its next
runs.`,
  async run(ctx, args) {
    const { values, positionals } = parseCommandArgs(
      args,
      { ...TASK_FLAG_OPTIONS, id: { type: "string" }, "json-input": { type: "boolean" } },
      { maxPositionals: 1 },
    );
    if (positionals[0] !== undefined && positionals[0] !== "-") throw new UsageError(`unexpected argument "${positionals[0]}"`);
    const fromStdin = values["json-input"] === true || positionals[0] === "-";
    if (fromStdin && values["instructions-file"] === "-") throw new UsageError("stdin can hold the task JSON or the instructions, not both");
    if (!fromStdin && values.at === undefined && values.cron === undefined) throw new UsageError("add needs --at <iso> or --cron <expr>");

    // Fields are unchecked until `taskErrors` runs below.
    const task: Partial<Task> = fromStdin ? parseJsonObject(await readStdin(), "the task on stdin") : {};
    await applyTaskFlags(ctx, task, values);

    const now = nowIso(ctx);
    task.cwd ??= ctx.cwd;
    task.machine ??= localMachine(ctx.config.config);
    task.enabled ??= true;
    task.created_at = now;
    task.updated_at = now;
    task.created_by = { cwd: displayPath(ctx, ctx.cwd), session: ctx.env.HC_TERMINAL_ID || null };
    task.schedule_since = null;

    const explicitId = values.id ?? task.id;
    // A placeholder id, so field errors are reported before id errors.
    const errors = taskErrors({ ...task, id: explicitId ?? "placeholder" });
    if (errors.length > 0) throw new ValidationError("task", errors);
    checkTaskMachine(ctx, task.machine);
    task.cwd = normalizeTaskCwd(ctx, task.cwd);

    const created = explicitId !== undefined ? createTaskWithId(ctx, task, explicitId) : createTaskFromTitle(ctx, task as Partial<Task> & { title: string });
    if (created.schedule.type === "once" && Date.parse(created.schedule.at) <= ctx.now.getTime() && !ctx.json) {
      ctx.stderr.write(`warning: ${created.schedule.at} is not in the future; the next tick runs it if it is within max_delay, otherwise it is missed\n`);
    }

    const overview = taskOverview(ctx, created);
    output(ctx, { task: created, next_runs: overview.next }, () =>
      [`Created task ${created.id}`, `  file: ${displayPath(ctx, taskPath(ctx.paths, created.id))}`, describeNext(overview)].join("\n"),
    );
  },
};

export default add;
