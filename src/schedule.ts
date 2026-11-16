import { Cron } from "croner";
import { parseDuration } from "./duration.ts";
import { type CatchUp, isFinalStatus, type Run, type Schedule, type Task } from "./schema.ts";
import { slotId } from "./store.ts";

export { formatDuration, parseDuration } from "./duration.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How far back reconciliation looks for unrecorded slots. */
export const LOOKBACK_MS = 30 * DAY;

/** Safety cap for very frequent cron expressions over a long window. */
const MAX_SLOTS = 100_000;

/** Default `max_delay`: 3 × the runner interval, never less than 15 minutes. */
export function defaultMaxDelay(runnerEveryMs: number): number {
  return Math.max(3 * runnerEveryMs, 15 * MINUTE);
}

/**
 * Scheduled instants of a schedule in `[from, to]` (both inclusive), oldest
 * first. Cron expressions are read in `timezone`; `starts_at` (inclusive) and
 * `until` (inclusive) narrow the window.
 */
export function slotsInWindow(schedule: Schedule, from: Date, to: Date, timezone: string): Date[] {
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return at >= from && at <= to ? [at] : [];
  }

  let start = from.getTime();
  let end = to.getTime();
  if (schedule.starts_at) start = Math.max(start, Date.parse(schedule.starts_at));
  if (schedule.until) end = Math.min(end, Date.parse(schedule.until));
  if (start > end) return [];

  const cron = new Cron(schedule.cron, { timezone, paused: true });
  const slots: Date[] = [];
  // nextRun() returns the first run strictly after its argument.
  let cursor: Date | null = new Date(start - 1);
  while (slots.length < MAX_SLOTS) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() > end) break;
    slots.push(cursor);
  }
  return slots;
}

/** The next `count` scheduled instants strictly after `now` (for display). */
export function nextRunTimes(task: Pick<Task, "schedule">, now: Date, count: number, timezone: string, { finished = false } = {}): Date[] {
  if (finished || count <= 0) return [];
  const { schedule } = task;
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return at > now ? [at] : [];
  }
  const start = schedule.starts_at ? Math.max(now.getTime() + 1, Date.parse(schedule.starts_at)) : now.getTime() + 1;
  const until = schedule.until ? Date.parse(schedule.until) : Number.POSITIVE_INFINITY;
  const cron = new Cron(schedule.cron, { timezone, paused: true });
  const out: Date[] = [];
  let cursor: Date | null = new Date(start - 1);
  while (out.length < count) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() > until) break;
    out.push(cursor);
  }
  return out;
}

/** A `once` task is finished when its scheduled occurrence reached a final state. */
export function isTaskFinished(task: Pick<Task, "schedule">, runs: readonly Pick<Run, "trigger" | "status">[]): boolean {
  if (task.schedule.type !== "once") return false;
  return runs.some((r) => r.trigger === "schedule" && isFinalStatus(r.status));
}

export type MissedReason = "runner_offline" | "runner_skipped";

export interface SlotRef {
  /** The scheduled instant. */
  at: Date;
  /** File-safe slot id, e.g. `20261117T080000Z`. */
  id: string;
}

export interface MissedSlot extends SlotRef {
  reason: MissedReason;
}

export interface CancelledSlot extends SlotRef {
  reason: "paused";
}

export interface SlotPlan {
  /** Slots to launch now, oldest first. */
  candidates: SlotRef[];
  missed: MissedSlot[];
  /** Late slots replaced by a more recent one (`catch_up: latest`). */
  superseded: SlotRef[];
  cancelled: CancelledSlot[];
}

export interface PlanInput {
  task: Pick<Task, "schedule" | "enabled" | "created_at">;
  now: Date;
  /** Slot ids (scheduled, not manual) that already have a run file. */
  recorded: ReadonlySet<string>;
  /** Times of past ticks (from `state/ticks.jsonl`); the current tick is not included. */
  ticks: readonly Date[];
  /** Resolved settings for the task (see `resolveFor`). */
  settings: { catch_up: CatchUp; max_delay: string; runner_every: string; timezone: string };
  /** For `once` tasks: true once the occurrence reached a final state (see `isTaskFinished`). */
  finished?: boolean;
}

function toRef(at: Date): SlotRef {
  return { at, id: slotId(at) };
}

/** `runner_skipped` if any tick ran while the slot could still have been launched, else `runner_offline`. */
function missedReason(slot: Date, deadline: number, ticks: readonly Date[]): MissedReason {
  const start = slot.getTime();
  return ticks.some((t) => t.getTime() >= start && t.getTime() <= deadline) ? "runner_skipped" : "runner_offline";
}

/**
 * Decides what to do with every unrecorded slot of a task up to `now`:
 * launch it, or record it as missed, superseded or cancelled. Pure: the clock
 * and the ticks are passed in.
 *
 * - Window: from `max(created_at, now - 30d)` to `now`.
 * - Paused task: every unrecorded slot is `cancelled` (`reason: paused`).
 * - A slot older than `max_delay` is `missed`.
 * - The rest are candidates, filtered by `catch_up`:
 *   - `latest`: only the newest is launched, older ones are `superseded`;
 *   - `all`: every candidate is launched, oldest first;
 *   - `none`: only a slot that is due within one runner interval is launched,
 *     anything later is `missed`.
 */
export function planSlots(input: PlanInput): SlotPlan {
  const plan: SlotPlan = { candidates: [], missed: [], superseded: [], cancelled: [] };
  if (input.finished) return plan;

  const { task, now, settings } = input;
  const from = new Date(Math.max(Date.parse(task.created_at), now.getTime() - LOOKBACK_MS));
  const slots = slotsInWindow(task.schedule, from, now, settings.timezone).filter((s) => !input.recorded.has(slotId(s)));

  if (!task.enabled) {
    plan.cancelled = slots.map((s) => ({ ...toRef(s), reason: "paused" }));
    return plan;
  }

  const maxDelay = parseDuration(settings.max_delay);
  const graceNone = parseDuration(settings.runner_every);
  const missed = (s: Date): MissedSlot => ({ ...toRef(s), reason: missedReason(s, Math.min(s.getTime() + maxDelay, now.getTime()), input.ticks) });

  const inTime: Date[] = [];
  for (const s of slots) {
    if (now.getTime() - s.getTime() > maxDelay) plan.missed.push(missed(s));
    else inTime.push(s);
  }

  switch (settings.catch_up) {
    case "all":
      plan.candidates = inTime.map(toRef);
      break;
    case "latest": {
      const newest = inTime.at(-1);
      plan.superseded = inTime.slice(0, -1).map(toRef);
      plan.candidates = newest ? [toRef(newest)] : [];
      break;
    }
    case "none": {
      for (const [i, s] of inTime.entries()) {
        const isNewest = i === inTime.length - 1;
        if (isNewest && now.getTime() - s.getTime() <= graceNone) plan.candidates.push(toRef(s));
        else plan.missed.push(missed(s));
      }
      plan.missed.sort((a, b) => a.at.getTime() - b.at.getTime());
      break;
    }
  }
  return plan;
}
