import { parseCommandArgs } from "../args.ts";
import { type Context, output } from "../context.ts";
import { runnerBanner, runnerDownReason } from "../output/banner.ts";
import { runSummary } from "../output/runs-table.ts";
import { scheduleText } from "../output/schedule-text.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { isFailure, paintMark, RUN_MARKS } from "../output/symbols.ts";
import { renderTable, truncate } from "../output/table.ts";
import { agendaTime, clockTime, relativeTime, sameDay } from "../output/time.ts";
import type { RunnerHealth } from "../runner-health.ts";
import type { Run, RunStatus, Task } from "../schema.ts";
import { listRuns, listTasks, readTicks, type StoredRun, taskIdsWithRuns } from "../store.ts";
import { displayTimezone, taskOverview, warnCorrupt } from "../task-info.ts";
import { formatInZone } from "../time.ts";
import type { Command } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A failure stays under "Attention" until a later success, or for this long. */
const FAILURE_WINDOW_MS = 7 * DAY_MS;
const NEXT_COUNT = 5;
const MISSED_TIMES_SHOWN = 5;

export const EXIT_ATTENTION = 1;

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

/** When the run last changed: the latest of its events, attempt starts and ends, and its slot. */
function lastActivity(run: Run): string {
  const times = [run.slot, ...run.events.map((e) => e.at), ...run.attempts.flatMap((a) => [a.started_at, a.finished_at ?? a.started_at])];
  return times.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest));
}

function offlineGaps(ctx: Context, missedSlots: readonly Date[]): OfflineGap[] {
  if (missedSlots.length === 0) return [];
  const tz = displayTimezone(ctx);
  const ticks = readTicks(ctx.paths).items.map((t) => Date.parse(t.at)).sort((a, b) => a - b);
  const gaps = new Map<string, OfflineGap>();
  for (const slot of missedSlots) {
    const t = slot.getTime();
    const before = ticks.filter((x) => x <= t).at(-1);
    const after = ticks.find((x) => x > t);
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
    const decisive = runs.filter(({ run }) => run.status === "succeeded" || isFailure(run.status)).at(-1);
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

function runnerLine(style: Style, health: RunnerHealth, now: Date): string {
  if (health.state !== "healthy") {
    return `${style.paint("red", "✕ not running")} · ${runnerDownReason(health, now)} · start it with: agent-tasks runner`;
  }
  const nextTick = new Date(health.next_tick!);
  const next = nextTick.getTime() <= now.getTime() ? "next due now" : `next ${relativeTime(nextTick, now)}`;
  return `${style.paint("green", "● alive")} · every ${health.every} · last tick ${relativeTime(new Date(health.last_tick!), now)} · ${next}`;
}

function gapText(gap: OfflineGap, tz: string, now: Date): string {
  const at = (iso: string) => agendaTime(new Date(iso), tz, now);
  if (gap.from && gap.to) {
    const to = sameDay(new Date(gap.from), new Date(gap.to), tz) ? clockTime(new Date(gap.to), tz) : at(gap.to);
    return `runner stopped ${at(gap.from)}–${to}`;
  }
  if (gap.from) return `runner stopped since ${at(gap.from)}`;
  return gap.to ? `runner stopped until ${at(gap.to)}` : "runner never ran";
}

function last24hLine(style: Style, report: StatusReport, tz: string, now: Date): string {
  const c = report.last_24h;
  const gaps = c.offline_gaps.map((g) => gapText(g, tz, now)).join(", ");
  const parts = [
    style.paint(c.ok > 0 ? "green" : undefined, `${c.ok} ok`),
    style.paint(c.failed > 0 ? "red" : undefined, `${c.failed} failed`),
    style.paint(c.missed > 0 ? "yellow" : undefined, `${c.missed} missed`) + (gaps ? ` (${gaps})` : ""),
    style.paint(c.running > 0 ? "cyan" : undefined, `${c.running} running`),
    ...(c.blocked > 0 ? [style.paint("magenta", `${c.blocked} blocked`)] : []),
  ];
  return parts.join(" · ");
}

function attentionRows(style: Style, items: readonly AttentionItem[], tz: string, now: Date): string[][] {
  return items.map((item) => {
    if (item.kind === "missed") {
      const times = item.slots.slice(-MISSED_TIMES_SHOWN).map((s) => agendaTime(new Date(s), tz, now));
      const more = item.slots.length > MISSED_TIMES_SHOWN ? ", …" : "";
      return [paintMark(style, RUN_MARKS.missed), item.task_id, `${item.slots.length} missed`, `(${times.join(", ")}${more})`, item.reason ?? ""];
    }
    const mark = RUN_MARKS[item.status];
    const summary = item.summary ? `"${truncate(item.summary, 60)}"` : "";
    return [paintMark(style, mark), item.ref, style.paint(mark.color, item.status), summary, relativeTime(new Date(item.at), now)];
  });
}

export function renderStatus(style: Style, report: StatusReport, tz: string, now: Date): string {
  const heading = (text: string) => style.paint("bold", text);
  const lines = [
    renderTable(
      [
        [heading("Runner"), runnerLine(style, report.runner, now)],
        [heading("Last 24h"), last24hLine(style, report, tz, now)],
      ],
      { header: false },
    ),
  ];
  if (report.attention.length > 0) {
    lines.push(heading("Attention"), renderTable(attentionRows(style, report.attention, tz, now), { header: false, indent: "  " }));
  }
  if (report.tasks === 0) lines.push("No tasks yet. Create one with: agent-tasks add --title … --cron … --instructions …");
  else if (report.next.length === 0) lines.push(`${heading("Upcoming")}  none`);
  else {
    lines.push(
      heading("Upcoming"),
      renderTable(
        report.next.map((n) => [agendaTime(new Date(n.at), tz, now), n.task_id, style.paint("dim", n.schedule)]),
        { header: false, indent: "  " },
      ),
    );
  }
  return lines.join("\n");
}

const status: Command = {
  name: "status",
  summary: "Is everything fine? Runner, last 24h, what needs attention, what's next",
  usage: `Usage: agent-tasks status

One screen: whether the runner is alive (from its heartbeat), what happened
in the last 24 hours, what needs attention (failed or timed out tasks whose
latest result is a failure, blocked runs waiting for a person, missed
occurrences in the last 24 hours) and the next run of up to ${NEXT_COUNT}
tasks, soonest first.

Exit code: 0 when the runner is alive and nothing needs attention, ${EXIT_ATTENTION}
otherwise, so it can be used in scripts or a status bar (--json works too).`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const health = runnerBanner(ctx);
    const report = buildStatus(ctx, health);
    warnCorrupt(ctx, report.errors.map((m) => new Error(m)));
    output(ctx, report, () => renderStatus(stdoutStyle(ctx), report, displayTimezone(ctx), ctx.now));
    return report.ok ? 0 : EXIT_ATTENTION;
  },
};

export default status;
