import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Context } from "../../../context.ts";
import { RUN_MARKS } from "../../../output/symbols.ts";
import { agendaTime, DAY, formatSpan } from "../../../output/time.ts";
import { isFailure, isInProgress, lastActivity } from "../../../run-info.ts";
import type { Run, RunStatus } from "../../../schema.ts";
import { isSlotId, runRef, slotIdToDate } from "../../../slot.ts";
import { readRun, taskIdsWithRuns } from "../../../store.ts";
import { findTask } from "../../../task-info.ts";
import type { DashRun } from "../../../tui/snapshot.ts";
import type { Segment } from "../../components/cells.ts";

// What the Runs tab shows, as plain data: the history of every task (archived
// ones included), newest first, read a page at a time. Run files are named
// after their slot, so the order and the `since` cut come from the file
// names alone; only the files of the rows shown (and those a status filter
// skips on the way) are read.

/** Rows read at a time; the next page is read when the cursor gets near the end. */
export const PAGE_SIZE = 100;
/** The next page is read when the cursor is this close to the last loaded row. */
export const LOAD_AHEAD = 20;

/** Skipped on purpose (a newer slot ran instead, the task was paused): not results, as in the Overview. */
const HIDDEN: readonly RunStatus[] = ["superseded", "cancelled"];

export const STATUS_FILTERS = ["all", "failures", "blocked", "ok", "missed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SINCE_FILTERS = ["all", "24h", "7d", "30d"] as const;
export type SinceFilter = (typeof SINCE_FILTERS)[number];

/** `S` goes from the shortest window to the longest, then back to everything. */
const SINCE_ORDER: readonly SinceFilter[] = ["24h", "7d", "30d", "all"];

const SINCE_MS: Record<Exclude<SinceFilter, "all">, number> = { "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

const STATUSES_OF: Record<Exclude<StatusFilter, "all">, readonly RunStatus[]> = {
  failures: ["failed", "timed_out"],
  blocked: ["blocked"],
  ok: ["succeeded"],
  missed: ["missed"],
};

export interface RunsFilter {
  status: StatusFilter;
  since: SinceFilter;
  /** The `/` text filter (task id and summary, any case); "" for none. Its input is the shared filter bar (wired by T6). */
  text: string;
}

export const DEFAULT_FILTER: RunsFilter = { status: "all", since: "all", text: "" };

export function nextStatus(status: StatusFilter): StatusFilter {
  return STATUS_FILTERS[(STATUS_FILTERS.indexOf(status) + 1) % STATUS_FILTERS.length]!;
}

export function nextSince(since: SinceFilter): SinceFilter {
  return SINCE_ORDER[(SINCE_ORDER.indexOf(since) + 1) % SINCE_ORDER.length]!;
}

/** A run of the history: what the Overview's rows carry (so the shared actions take it), plus the attempts allowed. */
export interface HistoryRun extends DashRun {
  /** Attempts allowed (`retries + 1`), or null when its task is gone or unreadable. */
  max_attempts: number | null;
}

export interface RunsPage {
  runs: HistoryRun[];
  /** More runs match beyond these: read them with a larger limit. */
  more: boolean;
}

function matches(run: Run, last: HistoryRun, filter: RunsFilter): boolean {
  if (HIDDEN.includes(run.status)) return false;
  if (filter.status !== "all" && !STATUSES_OF[filter.status].includes(run.status)) return false;
  if (filter.text !== "") {
    const needle = filter.text.toLowerCase();
    const haystack = `${run.task_id}\n${last.summary ?? ""}\n${last.reason ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function historyRun(ref: string, run: Run, taskMachine: string | null, max: number | null): HistoryRun {
  const last = run.attempts.at(-1);
  return {
    ref,
    task_id: run.task_id,
    status: run.status,
    slot: run.slot,
    attempt: last?.n ?? 0,
    started_at: last?.started_at ?? null,
    finished_at: last?.finished_at ?? null,
    at: lastActivity(run),
    summary: last?.summary ?? null,
    reason: last?.reason ?? run.reason ?? null,
    handle: last?.session?.handle ?? null,
    machine: last?.session?.machine ?? taskMachine,
    max_attempts: max,
  };
}

/**
 * The first `limit` runs that pass `filter`, newest slot first (the order of
 * `agent-tasks runs`). Unreadable run files are skipped: the data layer
 * reports them in the System tab.
 */
export function loadRuns(ctx: Context, filter: RunsFilter, limit: number): RunsPage {
  const since = filter.since === "all" ? null : ctx.now.getTime() - SINCE_MS[filter.since];
  const files: { taskId: string; slot: string; at: number }[] = [];
  for (const taskId of taskIdsWithRuns(ctx.paths)) {
    let names: string[];
    try {
      names = readdirSync(join(ctx.paths.runsDir, taskId));
    } catch {
      continue; // removed while we read
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const slot = basename(name, ".json");
      if (!isSlotId(slot)) continue;
      const at = slotIdToDate(slot).getTime();
      if (since !== null && at < since) continue;
      files.push({ taskId, slot, at });
    }
  }
  files.sort((a, b) => b.at - a.at || runRef(b.taskId, b.slot).localeCompare(runRef(a.taskId, a.slot)));

  const tasks = new Map<string, { machine: string; max: number } | null>();
  const taskOf = (id: string) => {
    if (!tasks.has(id)) {
      try {
        const { task } = findTask(ctx, id);
        tasks.set(id, { machine: task.machine, max: (task.retries ?? 0) + 1 });
      } catch {
        tasks.set(id, null); // removed or unreadable: no machine or limit to show
      }
    }
    return tasks.get(id)!;
  };

  const runs: HistoryRun[] = [];
  for (const file of files) {
    let run: Run;
    try {
      run = readRun(ctx.paths, file.taskId, file.slot);
    } catch {
      continue;
    }
    const task = taskOf(file.taskId);
    const row = historyRun(runRef(file.taskId, file.slot), run, task?.machine ?? null, task?.max ?? null);
    if (!matches(run, row, filter)) continue;
    if (runs.length === limit) return { runs, more: true };
    runs.push(row);
  }
  return { runs, more: false };
}

/** Whether the cursor at `index` of `loaded` rows is close enough to the end to read the next page. */
export function needsMore(index: number, loaded: number, more: boolean): boolean {
  return more && index >= loaded - LOAD_AHEAD;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const KEY_PREFIX = "run:";

/** Row keys are `run:<ref>`: selection follows the run across reloads and pages. */
export const rowKey = (ref: string) => `${KEY_PREFIX}${ref}`;
export const refOf = (key: string) => key.slice(KEY_PREFIX.length);

/** `2/3` (used/allowed), the plain count when the limit is unknown, `–` when it never started. */
export function attemptsText(run: HistoryRun): string {
  if (run.attempt === 0) return "–";
  return run.max_attempts === null ? String(run.attempt) : `${run.attempt}/${run.max_attempts}`;
}

/** How long the latest attempt took, or has been going on (it ticks with the clock). */
export function tookText(run: HistoryRun, now: Date): string {
  if (!run.started_at) return "–";
  const end = run.finished_at ? Date.parse(run.finished_at) : isInProgress(run.status) ? now.getTime() : null;
  return end === null ? "–" : formatSpan(end - Date.parse(run.started_at));
}

/** Status mark, slot, task, machine, took, attempts, summary or reason. */
export function runCells(run: HistoryRun, timezone: string, now: Date): Segment[] {
  const mark = RUN_MARKS[run.status];
  const slot = agendaTime(new Date(run.slot), timezone, now);
  const what: Segment = run.summary ? { text: run.summary.split("\n")[0]! } : { text: run.reason?.split("\n")[0] ?? "", color: "dim" };
  return [
    { text: mark.symbol, color: mark.color },
    { text: run.ref.includes("/manual-") ? `${slot} (manual)` : slot },
    { text: run.task_id },
    { text: run.machine ?? "", color: "dim" },
    { text: tookText(run, now) },
    { text: attemptsText(run), color: isFailure(run.status) && run.max_attempts !== null && run.attempt >= run.max_attempts ? "red" : undefined },
    what,
  ];
}

/** The chips above the list: the filters in use and how much is loaded. */
export function chipSegments(filter: RunsFilter, page: RunsPage): Segment[] {
  const chip = (label: string, value: string, active: boolean): Segment[] => [
    { text: `${label} `, color: "dim" },
    { text: ` ${value} `, color: active ? "inverse" : undefined },
  ];
  const count = page.runs.length === 0 ? "no runs" : page.more ? `${page.runs.length} shown, more as you scroll` : `${page.runs.length} run${page.runs.length === 1 ? "" : "s"}`;
  return [
    ...chip("status", filter.status, filter.status !== "all"),
    { text: "  " },
    ...chip("since", filter.since, filter.since !== "all"),
    ...(filter.text ? [{ text: "  " }, ...chip("/", filter.text, true)] : []),
    { text: `   ${count}`, color: "dim" },
  ];
}
