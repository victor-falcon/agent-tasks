import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { NotFoundError, UsageError } from "../errors.ts";
import { RUN_STATUSES, type RunStatus } from "../schema.ts";
import { isArchived, listRuns, taskExists, taskIdsWithRuns } from "../store.ts";
import { parseSince, runView, type RunView, table, warnCorrupt } from "../task-info.ts";
import { formatInZone, systemTimezone } from "../time.ts";
import type { Command } from "./types.ts";


const DEFAULT_LIMIT = 50;

function parseStatuses(value: string): RunStatus[] {
  const wanted = value.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = wanted.find((s) => !(RUN_STATUSES as readonly string[]).includes(s));
  if (bad !== undefined || wanted.length === 0) throw new UsageError(`--status: unknown status "${bad ?? ""}" (statuses: ${RUN_STATUSES.join(", ")})`);
  return wanted as RunStatus[];
}

/** Plain aligned table. Kept apart so the phase-2 renderer can replace it. */
export function renderRuns(ctx: Context, runs: readonly RunView[]): string {
  if (runs.length === 0) return "No runs.";
  const tz = ctx.config.config.timezone ?? systemTimezone();
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
    const statuses = values.status === undefined ? undefined : parseStatuses(values.status);
    let since: Date | undefined;
    if (values.since !== undefined) {
      try {
        since = parseSince(values.since, ctx);
      } catch (err) {
        throw new UsageError(`--since: ${(err as Error).message}`);
      }
    }
    if (values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit)) throw new UsageError(`--limit must be a positive integer (got "${values.limit}")`);
    const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);

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
      const more = views.length > shown.length ? `\n(${views.length - shown.length} more; use --limit)` : "";
      return renderRuns(ctx, shown) + more;
    });
  },
};

export default runs;
