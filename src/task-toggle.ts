import { type Context, output } from "./context.ts";
import { listRuns, readTask, writeTask } from "./store.ts";
import { nowIso } from "./task-flags.ts";
import { nextRuns, taskState } from "./task-info.ts";

/**
 * Sets `enabled` (shared by `pause` and `resume`). Resuming also sets
 * `schedule_since`, so slots that passed while paused are not reported as
 * missed. Doing it twice is a no-op.
 */
export function setEnabled(ctx: Context, id: string, enabled: boolean): void {
  const task = readTask(ctx.paths, id);
  const verb = enabled ? "resumed" : "paused";
  const changed = task.enabled !== enabled;
  if (changed) {
    const now = nowIso(ctx);
    task.enabled = enabled;
    task.updated_at = now;
    if (enabled) task.schedule_since = now;
    writeTask(ctx.paths, task);
  }
  const state = taskState(task, listRuns(ctx.paths, task.id).items.map((r) => r.run));
  const resolution = ctx.resolveFor(task);
  const next = nextRuns(task, state, resolution, ctx.now, 3);
  output(ctx, { task, changed, state, next_runs: next }, () => {
    const head = changed ? `${task.id} ${verb}.` : `${task.id} was already ${enabled ? "active" : "paused"}.`;
    if (!enabled) return `${head} Its slots are recorded as cancelled until "agent-tasks resume ${task.id}".`;
    return next.length > 0 ? `${head}\nNext runs (${resolution.timezone}):\n${next.map((t) => `  ${t}`).join("\n")}` : `${head} No upcoming runs (${state}).`;
  });
}
