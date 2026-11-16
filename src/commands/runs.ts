import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError } from "../errors.ts";
import { parseCount, parseEnumList } from "../input.ts";
import { RUN_STATUSES } from "../schema.ts";
import { runnerBanner } from "../output/banner.ts";
import { renderRunsTable } from "../output/runs-table.ts";
import { stdoutStyle } from "../output/style.ts";
import { isArchived, listRuns, type StoredRun, taskExists, taskIdsWithRuns } from "../store.ts";
import { displayTimezone, findTask, parseSince, runView, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const DEFAULT_LIMIT = 50;

/** Attempts allowed per task (`retries + 1`), for tasks that still exist. */
function maxAttemptsLookup(ctx: Context): (taskId: string) => number | undefined {
  const cache = new Map<string, number | undefined>();
  return (taskId) => {
    if (!cache.has(taskId)) {
      let max: number | undefined;
      try {
        max = (findTask(ctx, taskId).task.retries ?? 0) + 1;
      } catch {
        max = undefined; // removed or unreadable task: show the plain count
      }
      cache.set(taskId, max);
    }
    return cache.get(taskId);
  };
}

const runs: Command = {
  name: "runs",
  summary: "Show the occurrence history, newest first",
  usage: `Usage: agent-tasks runs [<id>] [--status <status,…>] [--since <duration|iso>] [--limit <n>]

Lists occurrences of every task (archived ones included) or of one task,
newest first: slot, status, when the first attempt started, how long the
latest one took, attempts (used/allowed) and the summary or the reason.
Pass the RUN column to "agent-tasks log" to see what happened.

Options:
  --status <statuses>  Only these statuses, comma-separated: ${RUN_STATUSES.join(", ")}
  --since <when>       Only slots from this point on: a duration back from now (7d, 24h) or an ISO time
  --limit <n>          At most n runs (default ${DEFAULT_LIMIT})`,
  run(ctx, args) {
    const { values, positionals } = parseCommandArgs(
      args,
      { status: { type: "string" }, since: { type: "string" }, limit: { type: "string" } },
      { maxPositionals: 1 },
    );
    const statuses = values.status === undefined ? undefined : parseEnumList("--status", values.status, RUN_STATUSES);
    const since = values.since === undefined ? undefined : parseSince(values.since, ctx.now);
    const limit = values.limit === undefined ? DEFAULT_LIMIT : parseCount("--limit", values.limit, 1);

    const id = positionals[0];
    let ids: string[];
    if (id !== undefined) {
      const known = taskExists(ctx.paths, id) || isArchived(ctx.paths, id) || taskIdsWithRuns(ctx.paths).includes(id);
      if (!known) throw new NotFoundError(`task "${id}" not found`);
      ids = [id];
    } else ids = taskIdsWithRuns(ctx.paths);

    const errors: Error[] = [];
    const matching: StoredRun[] = [];
    for (const taskId of ids) {
      const result = listRuns(ctx.paths, taskId);
      errors.push(...result.errors);
      for (const stored of result.items) {
        if (statuses && !statuses.includes(stored.run.status)) continue;
        if (since && Date.parse(stored.run.slot) < since.getTime()) continue;
        matching.push(stored);
      }
    }
    matching.sort((a, b) => Date.parse(b.run.slot) - Date.parse(a.run.slot) || b.ref.localeCompare(a.ref));
    const shown = matching.slice(0, limit);

    runnerBanner(ctx);
    warnCorrupt(ctx, errors);
    output(ctx, { runs: shown.map(runView), total: matching.length, errors: errors.map((e) => e.message) }, () => {
      if (shown.length === 0) return "No runs.";
      const tableText = renderRunsTable(shown, {
        style: stdoutStyle(ctx),
        timezone: displayTimezone(ctx),
        now: ctx.now,
        showRef: true,
        maxAttempts: maxAttemptsLookup(ctx),
      });
      const more = matching.length > shown.length ? `\n(${matching.length - shown.length} more; use --limit <n>)` : "";
      return `${tableText}${more}\nDetails of a run: agent-tasks log <run>`;
    });
  },
};

export default runs;
