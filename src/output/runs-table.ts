import type { Run } from "../schema.ts";
import type { StoredRun } from "../store.ts";
import type { Style } from "./style.ts";
import { isFailure, statusLabel } from "./symbols.ts";
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

/** How long the latest attempt took (or has been running). */
export function attemptDuration(run: Run, now: Date): number | null {
  const last = run.attempts.at(-1);
  if (!last) return null;
  const end = last.finished_at ? Date.parse(last.finished_at) : run.status === "running" || run.status === "blocked" ? now.getTime() : null;
  return end === null ? null : end - Date.parse(last.started_at);
}

/** The summary of the latest attempt, else the reason (`runner_offline`, `paused`…). */
export function runSummary(run: Run): string {
  return run.attempts.at(-1)?.summary ?? run.reason ?? "";
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
