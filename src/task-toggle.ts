import { type Context, output } from "./context.ts";
import type { Task } from "./schema.ts";
import { readTask, writeTask } from "./store.ts";
import { describeNext, nowIso, taskOverview } from "./task-info.ts";

/**
 * A copy of the task with `enabled` set and `updated_at` bumped. Enabling also
 * sets `schedule_since`, so slots that passed while it was off are not
 * reported as missed.
 */
export function withEnabled(ctx: Context, task: Task, enabled: boolean): Task {
  const now = nowIso(ctx);
  return { ...task, enabled, updated_at: now, ...(enabled ? { schedule_since: now } : {}) };
}

/** The body of `pause` and `resume`. Doing it twice is a no-op. */
export function setEnabled(ctx: Context, id: string, enabled: boolean): void {
  const stored = readTask(ctx.paths, id);
  const changed = stored.enabled !== enabled;
  const task = changed ? withEnabled(ctx, stored, enabled) : stored;
  if (changed) writeTask(ctx.paths, task);
  const overview = taskOverview(ctx, task);
  output(ctx, { task, changed, state: overview.state, next_runs: overview.next }, () => {
    const head = changed ? `${task.id} ${enabled ? "resumed" : "paused"}.` : `${task.id} was already ${enabled ? "enabled" : "paused"}.`;
    if (!enabled) return `${head} While paused, the runner records its slots as cancelled. Undo with "agent-tasks resume ${task.id}".`;
    return `${head}\n${describeNext(overview)}`;
  });
}
