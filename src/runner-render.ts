import { formatDuration } from "./duration.ts";
import type { ExecEvent } from "./execution.ts";
import { formatInZone } from "./time.ts";

// What the runner prints: the header, one line per event, the status line,
// and the terminal escapes Herdr reads (OSC 2 title, OSC 7501 agent state).
// Kept apart from the loop so it can later be aligned with the shared output
// module.

export interface Style {
  color: boolean;
}

const CODES = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, dim: 2, bold: 1 } as const;
export type Color = keyof typeof CODES;

export function paint(style: Style, color: Color, text: string): string {
  return style.color ? `\x1b[${CODES[color]}m${text}\x1b[0m` : text;
}

/** Colors only for a terminal, and never with NO_COLOR set to a non-empty value (https://no-color.org). */
export function useColor(isTTY: boolean, env: Record<string, string | undefined>): boolean {
  return isTTY && !env.NO_COLOR;
}

/** `HH:MM:SS` of an instant in a time zone. */
export function clockTime(at: Date | string, timezone: string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return formatInZone(date, timezone).slice(11, 19);
}

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

const SYMBOLS: Record<ExecEvent["type"], { symbol: string; color: Color }> = {
  launched: { symbol: "▶", color: "cyan" },
  succeeded: { symbol: "✓", color: "green" },
  failed: { symbol: "✕", color: "red" },
  timed_out: { symbol: "✕", color: "red" },
  missed: { symbol: "□", color: "magenta" },
  superseded: { symbol: "·", color: "dim" },
  cancelled: { symbol: "·", color: "dim" },
  blocked: { symbol: "!", color: "yellow" },
  anomaly: { symbol: "⚠", color: "yellow" },
};

/** Width the run ref is padded to, so details line up. */
const REF_WIDTH = 36;

function eventDetail(e: RunnerEvent): string {
  const attempt = e.attempt && e.attempt > 1 ? ` (attempt ${e.attempt})` : "";
  const took = e.duration_ms != null ? ` in ${formatDuration(e.duration_ms)}` : "";
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
  const time = paint(style, "dim", clockTime(line.at, timezone));
  switch (line.kind) {
    case "tick":
      return `${time}  ${paint(style, "dim", `tick  ${line.due} due · ${line.running} running`)}`;
    case "event": {
      const { symbol, color } = SYMBOLS[line.event.type];
      const ref = line.event.run_ref ?? line.event.task_id ?? "";
      const head = ref ? `${ref.padEnd(REF_WIDTH)} ` : "";
      return `${time}  ${paint(style, color, symbol)} ${head}${eventDetail(line.event)}`;
    }
    case "recovered":
      return `${time}  ${paint(style, "yellow", "↻")} runner recovered after ${formatDuration(line.gap_ms)} without ticks (last tick ${clockTime(line.last_tick, timezone)})`;
    case "warning":
      return `${time}  ${paint(style, "yellow", "⚠")} ${line.message}`;
  }
}

export interface HeaderInfo {
  every: string;
  launcher: string;
  agent: string;
  dataDir: string;
}

export function formatHeader(info: HeaderInfo, style: Style): string {
  return `${paint(style, "bold", "agent-tasks runner")} · every ${info.every} · launcher: ${info.launcher} (${info.agent}) · data: ${info.dataDir}`;
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
  const parts = [
    `${paint(style, health.color, "●")} ${health.text}`,
    `last tick ${info.last_tick ? clockTime(info.last_tick, timezone) : "never"}`,
    ...(info.next_tick ? [`next ${clockTime(info.next_tick, timezone).slice(0, 5)}`] : []),
    `running ${info.running}`,
    `today ${paint(style, "green", `✓${t.succeeded}`)} ${paint(style, "red", `✕${t.failed}`)} ${paint(style, "magenta", `□${t.missed}`)} ${paint(style, "yellow", `!${t.blocked}`)}`,
  ];
  return parts.join(" · ");
}

export const RULE = "─".repeat(77);

/** Clears the status block (rule + status line) so it can be redrawn below the next lines. */
export const CLEAR_STATUS = "\r\x1b[2K\x1b[1A\r\x1b[2K";

/** The status block: a rule and the status line, without a trailing newline (it is redrawn in place). */
export function formatStatusBlock(info: StatusInfo, timezone: string, style: Style): string {
  return `${paint(style, "dim", RULE)}\n${formatStatus(info, timezone, style)}`;
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
