import type { ExecEvent } from "./execution.ts";
import type { Color, Style } from "./output/style.ts";
import { type Mark, RUN_MARKS } from "./output/symbols.ts";
import { clockTimeWithSeconds as clockTime, formatSpan } from "./output/time.ts";

// What the runner prints: the header, one line per event, the status line,
// and the terminal escapes Herdr reads (OSC 2 title, OSC 7501 agent state).
// Colors, run marks and times come from the shared output module.

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** An event as the runner shows it: a tick event, plus how long the attempt took. */
export interface RunnerEvent extends ExecEvent {
  duration_ms?: number | null;
}

export type RunnerLine =
  | { kind: "tick"; at: Date; due: number; running: number }
  | { kind: "event"; at: Date; event: RunnerEvent }
  | { kind: "recovered"; at: Date; last_tick: Date; gap_ms: number }
  | { kind: "warning"; at: Date; message: string };

/** Run outcomes use the same marks as `list`, `show` and `runs`; launches and anomalies have their own. */
const SYMBOLS: Record<ExecEvent["type"], { symbol: string; color?: Color }> = {
  launched: { symbol: "▶", color: "cyan" },
  succeeded: RUN_MARKS.succeeded,
  failed: RUN_MARKS.failed,
  timed_out: RUN_MARKS.timed_out,
  missed: RUN_MARKS.missed,
  superseded: RUN_MARKS.superseded,
  cancelled: RUN_MARKS.cancelled,
  blocked: RUN_MARKS.blocked,
  anomaly: { symbol: "⚠", color: "yellow" },
};

/** Width the run ref is padded to, so details line up. */
const REF_WIDTH = 36;

function eventDetail(e: RunnerEvent): string {
  const attempt = e.attempt && e.attempt > 1 ? ` (attempt ${e.attempt})` : "";
  const took = e.duration_ms != null ? ` in ${formatSpan(e.duration_ms)}` : "";
  const reason = e.reason ? ` (${e.reason})` : "";
  const quoted = e.message ? ` · "${e.message}"` : "";
  const ref = e.run_ref ?? e.task_id;
  switch (e.type) {
    case "launched":
      return `launched${e.handle ? ` in ${e.handle}` : ""}${attempt}`;
    case "succeeded":
      return `succeeded${took}${attempt}${quoted}`;
    case "failed":
    case "timed_out":
      return `${e.type === "failed" ? "failed" : "timed out"}${reason}${took}${attempt}${e.message ? ` · ${e.message}` : ""}${ref ? ` · agent-tasks log ${ref}` : ""}`;
    case "blocked":
      return `blocked${attempt}${ref ? ` · agent-tasks attach ${ref}` : ""}`;
    case "missed":
    case "superseded":
    case "cancelled":
      return `${e.type}${reason}`;
    case "anomaly":
      return e.message ?? "anomaly";
  }
}

export function formatLine(line: RunnerLine, timezone: string, style: Style): string {
  const time = style.paint("dim", clockTime(line.at, timezone));
  switch (line.kind) {
    case "tick":
      return `${time}  ${style.paint("dim", `tick  ${line.due} due · ${line.running} running`)}`;
    case "event": {
      const { symbol, color } = SYMBOLS[line.event.type];
      const ref = line.event.run_ref ?? line.event.task_id ?? "";
      const head = ref ? `${ref.padEnd(REF_WIDTH)} ` : "";
      return `${time}  ${style.paint(color, symbol)} ${head}${eventDetail(line.event)}`;
    }
    case "recovered":
      return `${time}  ${style.paint("yellow", "↻")} runner recovered after ${formatSpan(line.gap_ms)} without ticks (last tick ${clockTime(line.last_tick, timezone)})`;
    case "warning":
      return `${time}  ${style.paint("yellow", "⚠")} ${line.message}`;
  }
}

export interface HeaderInfo {
  every: string;
  launcher: string;
  agent: string;
  dataDir: string;
}

export function formatHeader(info: HeaderInfo, style: Style): string {
  return `${style.paint("bold", "agent-tasks runner")} · every ${info.every} · launcher: ${info.launcher} (${info.agent}) · data: ${info.dataDir}`;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

export interface TodayCounts {
  succeeded: number;
  failed: number;
  missed: number;
  blocked: number;
}

export interface StatusInfo {
  health: "healthy" | "degraded" | "tick_failed" | "stopped";
  last_tick: Date | null;
  next_tick: Date | null;
  running: number;
  today: TodayCounts;
}

const HEALTH: Record<StatusInfo["health"], { text: string; color: Color }> = {
  healthy: { text: "healthy", color: "green" },
  degraded: { text: "degraded (see ⚠ above)", color: "yellow" },
  tick_failed: { text: "last tick failed", color: "red" },
  stopped: { text: "stopped", color: "dim" },
};

export function formatStatus(info: StatusInfo, timezone: string, style: Style): string {
  const health = HEALTH[info.health];
  const t = info.today;
  const counts: [Mark, number][] = [
    [RUN_MARKS.succeeded, t.succeeded],
    [RUN_MARKS.failed, t.failed],
    [RUN_MARKS.missed, t.missed],
    [RUN_MARKS.blocked, t.blocked],
  ];
  const parts = [
    `${style.paint(health.color, "●")} ${health.text}`,
    `last tick ${info.last_tick ? clockTime(info.last_tick, timezone) : "never"}`,
    ...(info.next_tick ? [`next ${clockTime(info.next_tick, timezone)}`] : []),
    `running ${info.running}`,
    `today ${counts.map(([mark, n]) => style.paint(mark.color, `${mark.symbol}${n}`)).join(" ")}`,
  ];
  return parts.join(" · ");
}

export const RULE = "─".repeat(77);

/** Clears the status block (rule + status line) so it can be redrawn below the next lines. */
export const CLEAR_STATUS = "\r\x1b[2K\x1b[1A\r\x1b[2K";

/**
 * The status block: a rule and the status line, without a trailing newline
 * (it is redrawn in place). The rule never exceeds the terminal's width, so
 * it does not wrap and break the redraw.
 */
export function formatStatusBlock(info: StatusInfo, timezone: string, style: Style, width?: number): string {
  const rule = width ? RULE.slice(0, Math.max(1, width - 1)) : RULE;
  return `${style.paint("dim", rule)}\n${formatStatus(info, timezone, style)}`;
}

// ---------------------------------------------------------------------------
// Terminal escapes for Herdr
// ---------------------------------------------------------------------------

export type AgentState = "idle" | "working" | "done" | "blocked" | "error";

/** OSC 2: sets the terminal (tab) title. */
export function oscTitle(title: string): string {
  return `\x1b]2;${title}\x07`;
}

/** OSC 7501: reports this terminal as an agent, so Herdr nests the task tabs under it. Fields are separated by a colon. */
export function oscAgentState(state: AgentState, app = "agent-tasks"): string {
  return `\x1b]7501;state=${state}:app=${app}\x07`;
}
