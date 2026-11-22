import { type Check, type CheckStatus } from "../../../checks.ts";
import { BUILTIN_DEFAULTS, isHub, type UserConfig } from "../../../config.ts";
import type { Context } from "../../../context.ts";
import { parseDuration } from "../../../duration.ts";
import { sshMachines } from "../../../machines.ts";
import type { Color } from "../../../output/style.ts";
import { agendaTime, clockTime, formatSpan, relativeTime } from "../../../output/time.ts";
import { tildify } from "../../../paths.ts";
import { lastTick } from "../../../runner-health.ts";
import { pidAlive, readRunnerLock, runnerLogPath } from "../../../runner-lock.ts";
import { parseLogLine } from "../../../tui/render.ts";
import { tailLines } from "../../../tui/snapshot.ts";
import type { Segment } from "../../components/cells.ts";

// What the System tab shows, as plain data so it is tested without a
// renderer: the runner (the same facts as `runner status`), the events of
// runner.log with their level filter and search, the machines and doctor
// checks (parsed from the CLI's --json), and the tab's badge.

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** A heartbeat older than this many intervals means the runner is stuck (as `runner status` says). */
const STALLED_INTERVALS = 3;

export interface RunnerInfo {
  alive: boolean;
  /** Alive, but no heartbeat for more than 3 intervals. */
  stalled: boolean;
  /** A lock left by a runner whose pid is gone. */
  staleLockPid: number | null;
  pid: number | null;
  /** `$HC_TERMINAL_ID` of its terminal, when it runs in Herdr. */
  terminal: string | null;
  startedAt: Date | null;
  every: string;
  lastTick: Date | null;
  lastTickMode: string | null;
  nextTick: Date | null;
  /** `herdr (claude)`: the config's launcher preset and agent. */
  launcher: string;
  dataDir: string;
}

/** The runner's facts from `state/runner.lock` and the heartbeat, read like `runner status` reads them. */
export function readRunnerInfo(ctx: Context): RunnerInfo {
  const lock = readRunnerLock(ctx.paths);
  const alive = lock !== null && pidAlive(lock.pid);
  const tick = lastTick(ctx.paths);
  const last = tick ? new Date(tick.at) : null;
  const every = alive ? lock!.every : ctx.resolveFor({ cwd: "/" }).runner_every;
  let everyMs: number | null = null;
  try {
    everyMs = parseDuration(every);
  } catch {
    everyMs = null;
  }
  const sinceLast = last ? ctx.now.getTime() - last.getTime() : null;
  const next = alive && lock!.next_tick_at ? new Date(lock!.next_tick_at) : null;
  return {
    alive,
    stalled: alive && sinceLast !== null && everyMs !== null && sinceLast > STALLED_INTERVALS * everyMs,
    staleLockPid: lock !== null && !alive ? lock.pid : null,
    pid: alive ? lock!.pid : null,
    terminal: alive ? lock!.terminal : null,
    startedAt: alive ? new Date(lock!.started_at) : null,
    every,
    lastTick: last,
    lastTickMode: tick?.mode ?? null,
    nextTick: next,
    launcher: describeLauncher(ctx.config.config),
    dataDir: tildify(ctx.paths.dataDir, ctx.env),
  };
}

/** `herdr (claude)`, as the runner's header writes it. */
function describeLauncher(config: UserConfig): string {
  const launcher = config.launcher ? (config.launcher.preset ?? "custom") : String(BUILTIN_DEFAULTS.launcher.preset);
  const agent = config.agent ? (typeof config.agent === "string" ? config.agent : config.agent.command) : BUILTIN_DEFAULTS.agent.command;
  return `${launcher} (${agent})`;
}

/** The Runner pane, one line each: state, where, interval, ticks, launcher, data. */
export function runnerLines(r: RunnerInfo, tz: string, now: Date): Segment[][] {
  const at = (d: Date) => `${agendaTime(d, tz, now)} (${relativeTime(d, now)})`;
  const label = (text: string): Segment => ({ text: text.padEnd(10), color: "dim" });
  const lines: Segment[][] = [];
  if (r.alive) {
    lines.push([{ text: "● ", color: r.stalled ? "yellow" : "green" }, { text: "running", color: "bold" }, { text: ` · pid ${r.pid}` }]);
    if (r.stalled && r.lastTick) lines.push([{ text: `⚠ no heartbeat for ${formatSpan(now.getTime() - r.lastTick.getTime())}: it may be stuck in a tick`, color: "yellow" }]);
    lines.push([label("where"), { text: r.terminal ? `terminal ${r.terminal}` : "a terminal outside Herdr" }]);
    if (r.startedAt) lines.push([label("since"), { text: at(r.startedAt) }]);
  } else {
    lines.push([{ text: "✕ ", color: "red" }, { text: "not running", color: "bold" }, ...(r.staleLockPid !== null ? [{ text: ` · stale lock from pid ${r.staleLockPid}`, color: "dim" as const }] : [])]);
    lines.push([label("start"), { text: "agent-tasks runner", color: "cyan" }, { text: " in a terminal tab", color: "dim" }]);
  }
  lines.push([label("every"), { text: r.every }]);
  lines.push([label("last tick"), { text: r.lastTick ? `${at(r.lastTick)}${r.lastTickMode ? ` · ${r.lastTickMode}` : ""}` : "none yet" }]);
  if (r.nextTick) lines.push([label("next tick"), { text: at(r.nextTick) }]);
  lines.push([label("launcher"), { text: r.launcher }]);
  lines.push([label("data"), { text: r.dataDir }]);
  return lines;
}

// ---------------------------------------------------------------------------
// Events (state/runner.log)
// ---------------------------------------------------------------------------

/** How many lines of runner.log the pane reads (from its end). */
export const EVENT_LINES = 1000;
const EVENT_BYTES = 256 * 1024;

export interface EventRow {
  /** Identity across reloads: the line's text, numbered when it repeats. */
  key: string;
  time: string;
  mark: string;
  task: string | null;
  /** The run the line names, if any: Enter opens it. */
  ref: string | null;
  what: string;
  note: string;
}

/** Colors of the marks runner.log uses (as the old Events panel). */
export const LOG_MARK_COLORS: Record<string, Color> = { "▶": "cyan", "■": "green", "✕": "red", "□": "yellow", "!": "magenta", "⚠": "yellow", "↻": "yellow", "●": "green", "○": "dim" };

/** Marks of failures, blocked and missed runs, and the runner's warnings. */
const PROBLEM_MARKS = new Set(["✕", "□", "!", "⚠", "↻"]);

const RUN_REF = /\b([\w.-]+\/\d{8}T\d{4,6}Z)\b/;

/** The last lines of runner.log. */
export function readEventLines(ctx: Context): string[] {
  return tailLines(runnerLogPath(ctx.paths), EVENT_LINES, EVENT_BYTES);
}

/** runner.log as rows, oldest first: tick heartbeats left out, a stop right before a start shown as one restart. */
export function parseEvents(lines: readonly string[]): EventRow[] {
  const rows: EventRow[] = [];
  const seen = new Map<string, number>();
  for (const line of lines) {
    const e = parseLogLine(line);
    if (e === null) continue;
    const previous = rows.at(-1);
    if (e.mark === "●" && previous?.mark === "○" && previous.what === "runner stopped") {
      rows[rows.length - 1] = { ...previous, time: e.time || previous.time, mark: "●", what: e.what.replace("runner started", "runner restarted") };
      continue;
    }
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    rows.push({ key: n === 1 ? line : `${line}#${n}`, ...e, ref: e.task !== null ? (RUN_REF.exec(line)?.[1] ?? null) : null });
  }
  return rows;
}

export const EVENT_FILTERS = ["all", "problems", "runs"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

export const EVENT_FILTER_LABELS: Record<EventFilter, string> = { all: "all", problems: "warnings and errors", runs: "runs" };

export function nextEventFilter(f: EventFilter): EventFilter {
  return EVENT_FILTERS[(EVENT_FILTERS.indexOf(f) + 1) % EVENT_FILTERS.length]!;
}

export function filterEvents(rows: readonly EventRow[], filter: EventFilter): EventRow[] {
  if (filter === "problems") return rows.filter((r) => PROBLEM_MARKS.has(r.mark));
  if (filter === "runs") return rows.filter((r) => r.task !== null);
  return [...rows];
}

/** The text a row shows (what the search looks in). */
export function eventText(r: EventRow): string {
  return [r.time, r.mark, r.task ?? "", r.what, r.note].filter((t) => t !== "").join(" ");
}

/** Keys of the rows that contain `query`, case ignored. */
export function matchingKeys(rows: readonly EventRow[], query: string): string[] {
  const q = query.toLowerCase();
  if (q === "") return [];
  return rows.filter((r) => eventText(r).toLowerCase().includes(q)).map((r) => r.key);
}

/**
 * The match to go to from the row at `from` (its key, or null): the next one
 * after it (`direction` 1) or before it (-1), wrapping around; the first
 * match from the top when nothing is selected.
 */
export function stepMatch(rows: readonly EventRow[], matches: readonly string[], from: string | null, direction: 1 | -1): string | null {
  if (matches.length === 0) return null;
  const order = rows.map((r) => r.key);
  const here = from === null ? -1 : order.indexOf(from);
  const set = new Set(matches);
  for (let step = 1; step <= order.length; step++) {
    const i = (((here + direction * step) % order.length) + order.length) % order.length;
    if (set.has(order[i]!)) return order[i]!;
  }
  return null;
}

/** An event's cells: time, mark, task, what happened, the note dimmed. */
export function eventSegments(r: EventRow, taskWidth: number, whatWidth: number): Segment[] {
  const color = LOG_MARK_COLORS[r.mark];
  const time: Segment = { text: r.time.padEnd(8), color: "dim" };
  if (r.task === null) return [time, { text: "  " }, { text: r.mark, color }, { text: " " }, { text: r.what, color: r.mark === "●" || r.mark === "○" ? "dim" : color }];
  const pad = (t: string, w: number) => t + " ".repeat(Math.max(0, w - Bun.stringWidth(t)));
  const outcome = r.mark === "■" || PROBLEM_MARKS.has(r.mark);
  return [
    time,
    { text: "  " },
    { text: r.mark, color },
    { text: " " },
    { text: pad(r.task, taskWidth) },
    { text: "  " },
    { text: pad(r.what, whatWidth), color: outcome ? color : undefined },
    ...(r.note ? [{ text: `  ${r.note.split("\n")[0]!}`, color: "dim" as const }] : []),
  ];
}

/** Widest the task and "what" columns get before they are cut. */
const TASK_WIDTH = 28;
const WHAT_WIDTH = 30;

export function eventColumnWidths(rows: readonly EventRow[]): { task: number; what: number } {
  const width = (texts: string[], max: number) => Math.min(max, Math.max(0, ...texts.map((t) => Bun.stringWidth(t))));
  const runs = rows.filter((r) => r.task !== null);
  return { task: width(runs.map((r) => r.task!), TASK_WIDTH), what: width(runs.map((r) => r.what), WHAT_WIDTH) };
}

/** `segments` with every occurrence of `query` (case ignored) in yellow. */
export function highlight(segments: readonly Segment[], query: string): Segment[] {
  if (query === "") return [...segments];
  const q = query.toLowerCase();
  return segments.flatMap((s) => {
    const out: Segment[] = [];
    const lower = s.text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
      if (i > at) out.push({ text: s.text.slice(at, i), color: s.color });
      out.push({ text: s.text.slice(i, i + q.length), color: "yellow" });
      at = i + q.length;
    }
    if (at < s.text.length) out.push({ text: s.text.slice(at), color: s.color });
    return out;
  });
}

// ---------------------------------------------------------------------------
// Checks (doctor) and machines (machines check)
// ---------------------------------------------------------------------------

/** The last result of a background check command, kept until it runs again. */
export interface CheckResult {
  checks: readonly Check[];
  at: Date;
}

/** The checks of `doctor --json` or `machines check --json`, or the reason they could not be read. */
export function parseChecksOutput(output: string): { checks: Check[] } | { error: string } {
  try {
    const data = JSON.parse(output) as { checks?: unknown; error?: { message?: unknown } };
    if (Array.isArray(data.checks)) return { checks: data.checks as Check[] };
    if (typeof data.error?.message === "string") return { error: data.error.message };
  } catch {
    // Not JSON: the command's own message says why.
  }
  const first = output.split("\n").find((l) => l.trim() !== "")?.trim();
  return { error: first || "no output" };
}

export const CHECK_MARKS: Record<CheckStatus, Segment> = { ok: { text: "✓", color: "green" }, warn: { text: "!", color: "yellow" }, error: { text: "✕", color: "red" } };

/** A check as lines: its mark and message, its details, and the fix. */
export function checkLines(c: Check): Segment[][] {
  return [
    [CHECK_MARKS[c.status], { text: " " }, { text: c.message, color: c.status === "ok" ? undefined : "bold" }],
    ...(c.details ?? []).map((d) => [{ text: `  - ${d}`, color: "dim" as const }]),
    ...(c.hint ? [[{ text: "  fix: ", color: "dim" as const }, { text: c.hint }]] : []),
  ];
}

/** `1 error, 2 warnings` or `all checks passed`. */
export function checksSummary(checks: readonly Check[]): string {
  const errors = checks.filter((c) => c.status === "error").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  if (errors === 0 && warnings === 0) return "all checks passed";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [errors > 0 ? plural(errors, "error") : null, warnings > 0 ? plural(warnings, "warning") : null].filter((s) => s !== null).join(", ");
}

/** Whether the config has machines to check (a hub with `machines`). */
export function hasMachines(config: UserConfig): boolean {
  return isHub(config) && sshMachines(config).length > 0;
}

/** The machine a check is about (`machine <name> (ssh …)`), or null. */
export function machineOfCheck(c: Check): string | null {
  if (c.id !== "machines.reachable") return null;
  return /^machine (\S+) \(ssh /.exec(c.message)?.[1] ?? null;
}

export interface MachineRow {
  name: string;
  ssh: string;
  /** Null until a check said something about it. */
  check: Check | null;
  at: Date | null;
}

/**
 * Each machine of the registry with its newest check: from `machines check`
 * or from doctor (which checks them too), whichever ran last.
 */
export function machineRows(config: UserConfig, results: readonly (CheckResult | null)[]): MachineRow[] {
  const newest = results.filter((r) => r !== null).sort((a, b) => a.at.getTime() - b.at.getTime());
  return sshMachines(config).map(({ machine, ssh }) => {
    let row: MachineRow = { name: machine, ssh, check: null, at: null };
    for (const result of newest) {
      const check = result.checks.find((c) => machineOfCheck(c) === machine);
      if (check) row = { ...row, check, at: result.at };
    }
    return row;
  });
}

/** A machine as lines: reachable or not, launcher ready or not, when checked, and the fix. */
export function machineLines(m: MachineRow, tz: string, now: Date, checking: boolean): Segment[][] {
  const head: Segment[] = [{ text: m.name, color: "bold" }, { text: `  ssh ${m.ssh}`, color: "dim" }];
  if (!m.check) return [[{ text: "· ", color: "dim" }, ...head, { text: checking ? "  checking…" : "  not checked yet", color: "dim" }]];
  const c = m.check;
  const unreachable = c.status === "warn";
  const state: Segment[] = unreachable
    ? [{ text: "unreachable", color: "yellow" }]
    : c.status === "ok"
      ? [{ text: "reachable", color: "green" }, { text: " · " }, { text: "launcher ready", color: "green" }]
      : [{ text: c.message.replace(/^machine \S+ \(ssh [^)]*\):? ?/, ""), color: "red" }];
  const when = m.at ? `checked ${clockTime(m.at, tz)} (${relativeTime(m.at, now)})${checking ? " · checking…" : ""}` : "";
  return [
    [CHECK_MARKS[c.status], { text: " " }, ...head],
    [{ text: "  " }, ...state, { text: `  ${when}`, color: "dim" }],
    ...(c.status !== "ok" && c.hint ? [[{ text: "  fix: ", color: "dim" as const }, { text: c.hint }]] : []),
  ];
}

/**
 * `!` on the tab when a check fails (an error, not a warning) or the data
 * layer reports unreadable files. A machine counts by its newest check, so a
 * `machines check` that passes clears what an older doctor said about it.
 */
export function systemBadge(doctor: CheckResult | null, machines: readonly MachineRow[], problems: number): string | null {
  const failing = (doctor?.checks.some((c) => c.status === "error" && machineOfCheck(c) === null) ?? false) || machines.some((m) => m.check?.status === "error");
  return failing || problems > 0 ? "!" : null;
}
