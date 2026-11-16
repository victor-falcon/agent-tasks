import type { Context } from "./context.ts";
import { AgentTasksError, UsageError } from "./errors.ts";
import { TASK_ID_RE, type Task } from "./schema.ts";
import { createJsonExclusive, isArchived, taskExists, taskIdsWithRuns, taskPath } from "./store.ts";
import { completeTask } from "./task-flags.ts";

const MAX_ID = 64;

/** `Weekly deps report!` → `weekly-deps-report`. Leaves room for a `-NNN` suffix. */
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

/** Why an id can't be used for a new task, or null. Ids with run history stay taken so old runs never attach to a new task. */
function takenBy(ctx: Context, id: string): string | null {
  if (taskExists(ctx.paths, id)) return "a task";
  if (isArchived(ctx.paths, id)) return "an archived task";
  if (taskIdsWithRuns(ctx.paths).includes(id)) return "the run history of a removed task";
  return null;
}

/** Creates the task file with this exact id; fails if the id is taken. */
export function createTaskWithId(ctx: Context, task: Partial<Task>, id: string): Task {
  if (!TASK_ID_RE.test(id)) throw new UsageError(`invalid task id "${id}" (lowercase letters, digits and dashes, max 64 chars)`);
  const owner = takenBy(ctx, id);
  const full = completeTask({ ...task, id });
  if (owner !== null || !createJsonExclusive(taskPath(ctx.paths, id), full)) {
    throw new AgentTasksError("conflict", `task id "${id}" is already used by ${owner ?? "a task"}; pick another id`);
  }
  return full;
}

/** Creates the task file with a slug of its title, adding `-2`, `-3`… when taken. */
export function createTaskFromTitle(ctx: Context, task: Partial<Task> & { title: string }): Task {
  const base = slugify(task.title);
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (takenBy(ctx, id) !== null) continue;
    const full = completeTask({ ...task, id });
    // Exclusive create: two concurrent `add`s with the same title get different ids.
    if (createJsonExclusive(taskPath(ctx.paths, id), full)) return full;
  }
  throw new AgentTasksError("conflict", `could not find a free id for "${base}"`);
}
