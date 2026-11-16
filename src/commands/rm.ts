import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { isFinalStatus } from "../schema.ts";
import { archiveTask, listRuns, readTask, taskPath } from "../store.ts";
import { displayPath } from "../task-flags.ts";
import { withEnabled } from "../task-toggle.ts";
import type { Command } from "./types.ts";

/** Quotes a path for a copy-pasteable shell command when it needs it. */
function shellQuote(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

const rm: Command = {
  name: "rm",
  summary: "Archive a task (its run history is kept)",
  usage: `Usage: agent-tasks rm <id>

Moves the task to <data_dir>/archive/<id>.json, paused, and keeps its runs.
It is reversible: move the file back to <data_dir>/tasks/ and resume it.`,
  run(ctx, args) {
    const { positionals } = parseCommandArgs(args, {}, { minPositionals: 1, maxPositionals: 1 });
    const stored = readTask(ctx.paths, positionals[0]!);
    // Archived paused, so a restored task needs a `resume`, which skips the slots it was away for.
    const task = stored.enabled ? withEnabled(ctx, stored, false) : stored;
    const unfinished = listRuns(ctx.paths, task.id).items.filter((r) => !isFinalStatus(r.run.status)).map((r) => r.ref);
    const file = archiveTask(ctx.paths, task);
    const restore = `mv ${shellQuote(displayPath(ctx, file))} ${shellQuote(displayPath(ctx, taskPath(ctx.paths, task.id)))} && agent-tasks resume ${task.id}`;
    output(ctx, { task, archived_to: file, restore, unfinished_runs: unfinished }, () =>
      [
        `Archived ${task.id} to ${displayPath(ctx, file)} (run history kept).`,
        ...(unfinished.length > 0 ? [`Still in progress: ${unfinished.join(", ")}. rm does not stop them.`] : []),
        "To restore it:",
        `  ${restore}`,
      ].join("\n"),
    );
  },
};

export default rm;
