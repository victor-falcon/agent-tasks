import type { Run, RunStatus } from "./schema.ts";

// Small read-only facts about one occurrence, shared by the views.

export function isFailure(status: RunStatus): boolean {
  return status === "failed" || status === "timed_out";
}

/** A result that says whether the task works: ok, failed or timed out. */
export function isDecisive(status: RunStatus): boolean {
  return status === "succeeded" || isFailure(status);
}

/** An agent is (or should be) alive for it. */
export function isInProgress(status: RunStatus): boolean {
  return status === "running" || status === "blocked";
}

/** Recorded without ever launching an agent. */
export function neverStarted(status: RunStatus): boolean {
  return status === "missed" || status === "superseded" || status === "cancelled";
}

/** How long the latest attempt took, or has been going on. */
export function attemptDuration(run: Run, now: Date): number | null {
  const last = run.attempts.at(-1);
  if (!last) return null;
  const end = last.finished_at ? Date.parse(last.finished_at) : isInProgress(run.status) ? now.getTime() : null;
  return end === null ? null : end - Date.parse(last.started_at);
}

/** The summary of the latest attempt, else the reason (`runner_offline`, `paused`…). */
export function runSummary(run: Run): string {
  return run.attempts.at(-1)?.summary ?? run.reason ?? "";
}

/** When the run last changed: the latest of its slot, events, attempt starts and ends. */
export function lastActivity(run: Run): string {
  const times = [run.slot, ...run.events.map((e) => e.at), ...run.attempts.flatMap((a) => [a.started_at, a.finished_at ?? a.started_at])];
  return times.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest));
}
