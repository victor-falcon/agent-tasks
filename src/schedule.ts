import { Cron } from "croner";
import { parseDuration } from "./duration.ts";
import { type CatchUp, type CronSchedule, isFinalStatus, type Run, type Schedule, type Task } from "./schema.ts";
import { slotId } from "./slot.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** How far back reconciliation looks for unrecorded slots. */
export const LOOKBACK_MS = 30 * DAY;

/** Safety cap for very frequent cron expressions over a long window. */
const MAX_SLOTS = 100_000;

/**
 * Cron instants in `[start, end]` (both inclusive, epoch ms), oldest first, at
 * most `limit`. `starts_at` and `until` (both inclusive) narrow the range.
 */
function cronSlots(schedule: CronSchedule, start: number, end: number, timezone: string, limit: number): Date[] {
  if (schedule.starts_at) start = Math.max(start, Date.parse(schedule.starts_at));
  if (schedule.until) end = Math.min(end, Date.parse(schedule.until));
  const slots: Date[] = [];
  if (start > end) return slots;
  const cron = new Cron(schedule.cron, { timezone, paused: true });
  // nextRun() returns the first run strictly after its argument.
  let cursor: Date | null = new Date(start - 1);
  while (slots.length < limit) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() > end) break;
    slots.push(cursor);
  }
  return slots;
}

/**
 * Scheduled instants of a schedule in `[from, to]` (both inclusive), oldest
 * first. Cron expressions are read in `timezone`.
 */
export function slotsInWindow(schedule: Schedule, from: Date, to: Date, timezone: string): Date[] {
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return at >= from && at <= to ? [at] : [];
  }
  return cronSlots(schedule, from.getTime(), to.getTime(), timezone, MAX_SLOTS);
}

/** The next `count` scheduled instants strictly after `now` (for display). */
export function nextRunTimes(task: Pick<Task, "schedule">, now: Date, count: number, timezone: string, { finished = false } = {}): Date[] {
  if (finished || count <= 0) return [];
  const { schedule } = task;
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return at > now ? [at] : [];
  }
  return cronSlots(schedule, now.getTime() + 1, Number.POSITIVE_INFINITY, timezone, count);
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
  /** True for a `once` task whose occurrence reached a final state (see `isTaskFinished`). */
  finished: boolean;
  /**
   * Optional extra lower bound for cron slots, e.g. when the schedule was last
   * changed or the task resumed, so slots of an old schedule are not reported.
   */
  since?: Date;
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
 * - Window: from `max(created_at, since, now - 30d)` to `now`. A `once` slot
 *   ignores `created_at`/`since`, so an `at` slightly in the past when the
 *   task was created is still launched or reported, never dropped.
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
  const lookback = now.getTime() - LOOKBACK_MS;
  const from = new Date(task.schedule.type === "once" ? lookback : Math.max(Date.parse(task.created_at), input.since?.getTime() ?? lookback, lookback));
  const slots = slotsInWindow(task.schedule, from, now, settings.timezone).filter((s) => !input.recorded.has(slotId(s)));

  if (!task.enabled) {
    plan.cancelled = slots.map((s) => ({ ...toRef(s), reason: "paused" }));
    return plan;
  }

  const maxDelay = parseDuration(settings.max_delay);
  const dueWindow = parseDuration(settings.runner_every);
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
        if (isNewest && now.getTime() - s.getTime() <= dueWindow) plan.candidates.push(toRef(s));
        else plan.missed.push(missed(s));
      }
      plan.missed.sort((a, b) => a.at.getTime() - b.at.getTime());
      break;
    }
  }
  return plan;
}
