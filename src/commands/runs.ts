import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { NotFoundError } from "../errors.ts";
import { parseCount, parseEnumList } from "../input.ts";
import { RUN_STATUSES } from "../schema.ts";
import { isArchived, listRuns, taskExists, taskIdsWithRuns } from "../store.ts";
import { displayTimezone, parseSince, runView, type RunView, table, warnCorrupt } from "../task-info.ts";
import { formatInZone } from "../time.ts";
import type { Command } from "./types.ts";

const DEFAULT_LIMIT = 50;

/** Plain aligned table. Kept apart so the phase-2 renderer can replace it. */
export function renderRuns(runs: readonly RunView[], tz: string): string {
  if (runs.length === 0) return "No runs.";
  return table([
    ["RUN", "SLOT", "TRIGGER", "STATUS", "REASON", "ATTEMPTS", "SUMMARY"],
    ...runs.map((r) => [r.ref, formatInZone(new Date(r.slot), tz), r.trigger, r.status, r.reason ?? "-", String(r.attempts), r.summary ?? "-"]),
  ]);
}

const runs: Command = {
  name: "runs",
  summary: "Show the occurrence history, newest first",
  usage: `Usage: agent-tasks runs [<id>] [--status <status,…>] [--since <duration|iso>] [--limit <n>]

Lists occurrences of every task (archived ones included) or of one task,
newest first.

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
    const views: RunView[] = [];
    for (const taskId of ids) {
      const result = listRuns(ctx.paths, taskId);
      errors.push(...result.errors);
      for (const stored of result.items) {
        if (statuses && !statuses.includes(stored.run.status)) continue;
        if (since && Date.parse(stored.run.slot) < since.getTime()) continue;
        views.push(runView(stored));
      }
    }
    views.sort((a, b) => Date.parse(b.slot) - Date.parse(a.slot) || b.ref.localeCompare(a.ref));
    const shown = views.slice(0, limit);

    warnCorrupt(ctx, errors);
    output(ctx, { runs: shown, total: views.length, errors: errors.map((e) => e.message) }, () => {
      const more = views.length > shown.length ? `\n(${views.length - shown.length} more; use --limit <n>)` : "";
      return renderRuns(shown, displayTimezone(ctx)) + more;
    });
  },
};

export default runs;
