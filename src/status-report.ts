import type { Context } from "./context.ts";
import { scheduleText } from "./output/schedule-text.ts";
import { DAY } from "./output/time.ts";
import { isDecisive, isFailure, lastActivity, runSummary } from "./run-info.ts";
import type { RunnerHealth } from "./runner-health.ts";
import type { RunStatus, Task } from "./schema.ts";
import { listRuns, listTasks, readTicks, type StoredRun, taskIdsWithRuns } from "./store.ts";
import { displayTimezone, taskOverview } from "./task-info.ts";
import { formatInZone } from "./time.ts";

// The data behind `agent-tasks status`: counts, what needs attention, what's next.

const DAY_MS = DAY;
/** A failure stays under "Attention" until a later success, or for this long. */
const FAILURE_WINDOW_MS = 7 * DAY_MS;
export const NEXT_COUNT = 5;

/** A stretch without heartbeat that explains `runner_offline` misses. Null ends: no tick before / none since. */
export interface OfflineGap {
  from: string | null;
  to: string | null;
}

export type AttentionItem =
  | { kind: "failed" | "blocked"; task_id: string; ref: string; status: RunStatus; summary: string | null; at: string }
  | { kind: "missed"; task_id: string; reason: string | null; slots: string[] };

export interface NextRun {
  task_id: string;
  at: string;
  schedule: string;
}

export interface StatusReport {
  /** True when the runner is healthy and nothing needs attention (exit code 0). */
  ok: boolean;
  runner: RunnerHealth;
  /** Saved tasks (active, paused or finished; not archived). */
  tasks: number;
  last_24h: { ok: number; failed: number; missed: number; offline_gaps: OfflineGap[]; running: number; blocked: number };
  attention: AttentionItem[];
  next: NextRun[];
  errors: string[];
}

/** Index of the first value greater than `t` in a sorted array (its length if none). */
function firstAfter(sorted: readonly number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function offlineGaps(ctx: Context, missedSlots: readonly Date[]): OfflineGap[] {
  if (missedSlots.length === 0) return [];
  const tz = displayTimezone(ctx);
  const ticks = readTicks(ctx.paths).items.map((t) => Date.parse(t.at)).sort((a, b) => a - b);
  const gaps = new Map<string, OfflineGap>();
  for (const slot of missedSlots) {
    const i = firstAfter(ticks, slot.getTime());
    const before = ticks[i - 1];
    const after = ticks[i];
    const iso = (ms: number | undefined) => (ms === undefined ? null : formatInZone(new Date(ms), tz));
    const gap = { from: iso(before), to: iso(after) };
    gaps.set(`${gap.from}|${gap.to}`, gap);
  }
  return [...gaps.values()].sort((a, b) => (a.from === null ? -1 : b.from === null ? 1 : Date.parse(a.from) - Date.parse(b.from)));
}

export function buildStatus(ctx: Context, health: RunnerHealth): StatusReport {
  const now = ctx.now.getTime();
  const tasks = listTasks(ctx.paths);
  const errors: Error[] = [...tasks.errors];
  const byId = new Map<string, Task>(tasks.items.map((t) => [t.id, t]));
  const ids = [...new Set([...byId.keys(), ...taskIdsWithRuns(ctx.paths)])].sort();

  const counts = { ok: 0, failed: 0, missed: 0, running: 0, blocked: 0 };
  const offlineSlots: Date[] = [];
  const attention: AttentionItem[] = [];
  const next: NextRun[] = [];

  for (const id of ids) {
    const task = byId.get(id);
    let runs: StoredRun[];
    if (task) {
      const overview = taskOverview(ctx, task, { nextCount: 1 });
      errors.push(...overview.errors);
      runs = overview.runs;
      for (const at of overview.next) next.push({ task_id: id, at, schedule: scheduleText(task.schedule, overview.resolution.timezone, ctx.now) });
    } else {
      const result = listRuns(ctx.paths, id); // a removed or archived task: only its live runs matter
      errors.push(...result.errors);
      runs = result.items;
    }

    const missedByReason = new Map<string | null, string[]>();
    for (const { ref, run } of runs) {
      if (run.status === "running") counts.running++;
      if (run.status === "blocked") {
        counts.blocked++;
        attention.push({ kind: "blocked", task_id: id, ref, status: run.status, summary: runSummary(run) || null, at: lastActivity(run) });
      }
      const slot = Date.parse(run.slot);
      if (slot > now || slot < now - DAY_MS) continue;
      if (run.status === "succeeded") counts.ok++;
      else if (isFailure(run.status)) counts.failed++;
      else if (run.status === "missed") {
        counts.missed++;
        if (run.reason === "runner_offline") offlineSlots.push(new Date(run.slot));
        if (task) missedByReason.set(run.reason, [...(missedByReason.get(run.reason) ?? []), run.slot]);
      }
    }
    if (!task) continue;

    // The latest decisive result: a failure stays until a later success, for a week at most.
    const decisive = runs.filter(({ run }) => isDecisive(run.status)).at(-1);
    if (decisive && isFailure(decisive.run.status)) {
      const at = lastActivity(decisive.run);
      if (Date.parse(at) >= now - FAILURE_WINDOW_MS) {
        attention.push({ kind: "failed", task_id: id, ref: decisive.ref, status: decisive.run.status, summary: runSummary(decisive.run) || null, at });
      }
    }
    for (const [reason, slots] of missedByReason) attention.push({ kind: "missed", task_id: id, reason, slots });
  }

  next.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.task_id.localeCompare(b.task_id));
  const order = { failed: 0, blocked: 1, missed: 2 } as const;
  attention.sort((a, b) => order[a.kind] - order[b.kind] || a.task_id.localeCompare(b.task_id));
  return {
    ok: health.state === "healthy" && attention.length === 0,
    runner: health,
    tasks: tasks.items.length,
    last_24h: { ...counts, offline_gaps: offlineGaps(ctx, offlineSlots) },
    attention,
    next: next.slice(0, NEXT_COUNT),
    errors: errors.map((e) => e.message),
  };
}
