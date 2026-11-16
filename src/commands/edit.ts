import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { UsageError, ValidationError } from "../errors.ts";
import { isObject, type Task, taskErrors } from "../schema.ts";
import { listRuns, readTask, writeTask } from "../store.ts";
import { applyTaskFlags, normalizeTaskCwd, nowIso, orderTaskKeys, parseJsonObject, readFileArg, TASK_FLAG_OPTIONS, TASK_FLAGS_USAGE } from "../task-flags.ts";
import { nextRuns, taskState } from "../task-info.ts";
import type { Command } from "./types.ts";

/** Fields `edit` keeps for itself; a patch may repeat them unchanged but not change them. */
const READ_ONLY = ["id", "created_at", "created_by", "updated_at", "schedule_since"] as const;

/**
 * Applies a JSON patch: top-level fields replace the task's, except
 * `schedule`, which is merged into the current one when it keeps the same
 * `type` (so `{"schedule":{"cron":"0 10 * * *"}}` keeps the time zone).
 */
export function applyPatch(task: Task, patch: Record<string, unknown>): Task {
  for (const key of READ_ONLY) {
    if (key in patch && !Bun.deepEquals(patch[key], task[key])) throw new UsageError(`"${key}" cannot be changed with edit`);
  }
  const next: Record<string, unknown> = { ...task, ...patch };
  if (isObject(patch.schedule) && (patch.schedule.type === undefined || patch.schedule.type === task.schedule.type)) {
    next.schedule = { ...task.schedule, ...patch.schedule };
  }
  return next as unknown as Task;
}

const CHANGE_KEYS = ["title", "description", "cwd", "instructions", "schedule", "agent", "catch_up", "max_delay", "timeout", "retries", "keep_open", "enabled"] as const;

const edit: Command = {
  name: "edit",
  summary: "Change a task's fields",
  usage: `Usage: agent-tasks edit <id> [field options]
       agent-tasks edit <id> --file <patch.json>
       agent-tasks edit <id> - < patch.json

Changes the given fields, revalidates the task and sets updated_at. A JSON
patch replaces top-level fields ("schedule" is merged when its type stays
the same); field options are applied after it. An empty value
(--timeout "") resets a field to the default from the config.

When the schedule changes (or a patch sets "enabled": true), slots before
now are ignored, so the old schedule doesn't produce a burst of missed runs.

Options:
${TASK_FLAGS_USAGE}
  --file <path>               JSON patch from a file ("-" for stdin)`,
  async run(ctx, args) {
    const { values, positionals } = parseCommandArgs(args, { ...TASK_FLAG_OPTIONS, file: { type: "string" } }, { minPositionals: 1, maxPositionals: 2 });
    if (positionals[1] !== undefined && positionals[1] !== "-") throw new UsageError(`unexpected argument "${positionals[1]}"`);
    if (positionals[1] === "-" && values.file !== undefined) throw new UsageError('use either --file or "-", not both');
    const patchFile = values.file ?? positionals[1];
    if (patchFile === "-" && values["instructions-file"] === "-") throw new UsageError("stdin can hold the patch or the instructions, not both");

    const flags = Object.keys(values).filter((k) => k !== "file");
    if (patchFile === undefined && flags.length === 0) throw new UsageError("nothing to change: pass field options, --file or -");

    const old = readTask(ctx.paths, positionals[0]!);
    let task = structuredClone(old);
    if (patchFile !== undefined) task = applyPatch(task, parseJsonObject(await readFileArg(ctx, patchFile), "the patch"));
    await applyTaskFlags(ctx, task, values);
    if (task.cwd !== old.cwd) task.cwd = normalizeTaskCwd(ctx, task.cwd);

    const changed = CHANGE_KEYS.filter((k) => !Bun.deepEquals(task[k], old[k]));
    const unknown = Object.keys(task).filter((k) => !(k in old) && !(CHANGE_KEYS as readonly string[]).includes(k));
    if (changed.length === 0 && unknown.length === 0) {
      output(ctx, { task: old, changed: [] }, `No changes to ${old.id}.`);
      return;
    }

    const now = nowIso(ctx);
    task.updated_at = now;
    if (changed.includes("schedule") || (task.enabled && !old.enabled)) task.schedule_since = now;
    const errors = taskErrors(task);
    if (errors.length > 0) throw new ValidationError("task", errors);
    task = orderTaskKeys(task as unknown as Record<string, unknown>) as unknown as Task;
    writeTask(ctx.paths, task);

    const state = taskState(task, listRuns(ctx.paths, task.id).items.map((r) => r.run));
    const resolution = ctx.resolveFor(task);
    const next = nextRuns(task, state, resolution, ctx.now, 3);
    output(ctx, { task, changed, next_runs: next }, () =>
      [
        `Updated ${task.id}: ${changed.join(", ")}`,
        next.length > 0 ? `Next runs (${resolution.timezone}):\n${next.map((t) => `  ${t}`).join("\n")}` : `No upcoming runs (${state}).`,
      ].join("\n"),
    );
  },
};

export default edit;
