import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { runnerBanner, runnerDownReason } from "../output/banner.ts";
import { stdoutStyle, type Style } from "../output/style.ts";
import { paintMark, RUN_MARKS } from "../output/symbols.ts";
import { renderTable, truncate } from "../output/table.ts";
import { agendaTime, clockTime, relativeTime, sameDay } from "../output/time.ts";
import type { RunnerHealth } from "../runner-health.ts";
import { type AttentionItem, buildStatus, NEXT_COUNT, type OfflineGap, type StatusReport } from "../status-report.ts";
import { displayTimezone, warnCorrupt } from "../task-info.ts";
import type { Command } from "./types.ts";

const MISSED_TIMES_SHOWN = 5;
export const EXIT_ATTENTION = 1;

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
  ];
  return parts.join(" · ");
}

function nowLine(style: Style, report: StatusReport): string {
  const { running, blocked } = report.now;
  return [style.paint(running > 0 ? "cyan" : undefined, `${running} running`), style.paint(blocked > 0 ? "magenta" : undefined, `${blocked} blocked`)].join(" · ");
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
        [heading("Now"), nowLine(style, report)],
      ],
      { header: false },
    ),
  ];
  if (report.attention.length > 0) {
    lines.push(heading("Attention"), renderTable(attentionRows(style, report.attention, tz, now), { header: false, indent: "  " }));
  }
  if (report.errors.length > 0) lines.push(style.paint("yellow", `${report.errors.length} file${report.errors.length === 1 ? "" : "s"} could not be read (see the warnings above)`));
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
in the last 24 hours, what is running now, what needs attention and the next
run of up to ${NEXT_COUNT} tasks, soonest first.

Under "Attention":
  ✕  a task (not paused) whose latest result failed or timed out, for up to 7 days
  !  a run that is blocked, waiting for a person
  □  occurrences missed in the last 24 hours, until the task succeeds again

Exit code: 0 when the runner is alive, nothing needs attention and every file
could be read; ${EXIT_ATTENTION} otherwise. So it works in scripts and status bars
(--json too).`,
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
