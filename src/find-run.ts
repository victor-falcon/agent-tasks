import type { Context } from "./context.ts";
import { NotFoundError, UsageError } from "./errors.ts";
import { type Run, TASK_ID_RE } from "./schema.ts";
import { parseRunRef } from "./slot.ts";
import { isArchived, listRuns, readRun, taskExists } from "./store.ts";
import { warnCorrupt } from "./task-info.ts";

/**
 * A run ref (`<task-id>/<slot>`), or for a task id the run `pick` chooses
 * from the task's runs (oldest first; by default the latest). `pick` returns
 * undefined to fall through to "no runs" errors, or throws its own.
 */
export function findRun(ctx: Context, arg: string, pick: (runs: Run[]) => Run | undefined = (runs) => runs.at(-1)): Run {
  if (arg.includes("/")) {
    const { taskId, slot } = parseRunRef(arg);
    return readRun(ctx.paths, taskId, slot);
  }
  if (!TASK_ID_RE.test(arg)) throw new UsageError(`invalid run ref or task id "${arg}" (expected <task-id> or <task-id>/<slot>)`);
  const { items, errors } = listRuns(ctx.paths, arg);
  // An unreadable file could be the latest run: say so rather than pass an older one off as the latest.
  warnCorrupt(ctx, errors);
  const runs = items.map((i) => i.run);
  const found = runs.length > 0 ? pick(runs) : undefined;
  if (found) return found;
  if (taskExists(ctx.paths, arg) || isArchived(ctx.paths, arg)) throw new NotFoundError(`task "${arg}" has no runs yet`);
  throw new NotFoundError(`task "${arg}" not found (run "agent-tasks list --all" to see every task)`);
}
