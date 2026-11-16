import { attemptDuration, isFailure, runSummary } from "../run-info.ts";
import type { Run } from "../schema.ts";
import type { StoredRun } from "../store.ts";
import type { Style } from "./style.ts";
import { statusLabel } from "./symbols.ts";
import { renderTable, truncate } from "./table.ts";
import { absoluteTime, formatSpan, timeNear } from "./time.ts";

const SUMMARY_MAX = 72;

export interface RunsTableOptions {
  style: Style;
  timezone: string;
  now: Date;
  /** Add the run ref as the first column (to pass to `agent-tasks log`). */
  showRef?: boolean;
  /** Attempts allowed per task id (`retries + 1`), to show `2/2`. */
  maxAttempts?: (taskId: string) => number | undefined;
  indent?: string;
}

/** `Nov 17 09:00`, or `Nov 17 09:12 (manual)`. */
export function slotLabel(run: Run, timezone: string, now: Date): string {
  const at = absoluteTime(new Date(run.slot), timezone, now);
  return run.trigger === "manual" ? `${at} (manual)` : at;
}

/** SLOT, STATUS, START, DURATION, ATT., SUMMARY (newest first, as given). */
export function renderRunsTable(runs: readonly StoredRun[], { style, timezone, now, showRef = false, maxAttempts, indent }: RunsTableOptions): string {
  const header = [...(showRef ? ["RUN"] : []), "SLOT", "STATUS", "START", "DURATION", "ATT.", "SUMMARY"];
  const rows = runs.map(({ ref, run }) => {
    const first = run.attempts[0];
    const start = first ? timeNear(new Date(first.started_at), new Date(run.slot), timezone, now) : "—";
    const duration = attemptDuration(run, now);
    const max = maxAttempts?.(run.task_id);
    // `2/2` when retries were used or the run failed (no tries left), plain `1` otherwise.
    const used = run.attempts.length;
    const showMax = max !== undefined && max > 1 && (used > 1 || isFailure(run.status));
    const attempts = used === 0 ? "—" : showMax ? `${used}/${max}` : String(used);
    return [
      ...(showRef ? [ref] : []),
      slotLabel(run, timezone, now),
      statusLabel(style, run.status),
      start,
      duration === null ? "—" : formatSpan(duration),
      attempts,
      truncate(runSummary(run), SUMMARY_MAX),
    ];
  });
  return renderTable([header, ...rows], { style, indent });
}
