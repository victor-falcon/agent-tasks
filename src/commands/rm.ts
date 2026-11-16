import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { tildify } from "../paths.ts";
import { archiveTask, readTask, taskPath } from "../store.ts";
import { nowIso } from "../task-flags.ts";
import type { Command } from "./types.ts";

const rm: Command = {
  name: "rm",
  summary: "Archive a task (its run history is kept)",
  usage: `Usage: agent-tasks rm <id>

Moves the task to <data_dir>/archive/<id>.json, paused, and keeps its runs.
It is reversible: move the file back to <data_dir>/tasks/ and resume it.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const task = readTask(ctx.paths, positionals[0]!);
    // Archived paused, so a restored task needs a `resume`, which skips the slots it was away for.
    const archived = task.enabled ? { ...task, enabled: false, updated_at: nowIso(ctx) } : task;
    const file = archiveTask(ctx.paths, archived);
    const restore = `mv ${tildify(file, ctx.env)} ${tildify(taskPath(ctx.paths, task.id), ctx.env)} && agent-tasks resume ${task.id}`;
    output(ctx, { task: archived, archived_to: file, restore }, `Archived ${task.id} to ${tildify(file, ctx.env)} (run history kept).\nTo restore it:\n  ${restore}`);
  },
};

export default rm;
