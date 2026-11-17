import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_DEFAULTS } from "./config.ts";
import type { Context, Writer } from "./context.ts";
import { formatDuration, parseDuration } from "./duration.ts";
import { AgentTasksError } from "./errors.ts";
import type { ExecEvent } from "./execution.ts";
import { defaultNotifierDeps, dispatchNotifications, isNotifyItem, type NotifierDeps, type NotifyItem } from "./notifiers/index.ts";
import { tildify } from "./paths.ts";
import { acquireRunnerLock, pidAlive, releaseRunnerLock, runnerLogPath, type RunnerLock, updateRunnerLock } from "./runner-lock.ts";
import {
  type AgentState,
  CLEAR_STATUS,
  formatHeader,
  formatLine,
  formatStatus,
  formatStatusBlock,
  oscAgentState,
  oscTitle,
  type RunnerEvent,
  type RunnerLine,
  type StatusInfo,
  type TodayCounts,
} from "./runner-render.ts";
import { colorEnabled, createStyle, type Style } from "./output/style.ts";
import { clockTimeWithSeconds } from "./output/time.ts";
import { lastTick } from "./runner-health.ts";
import { listRuns, listTasks, readRunByRef, taskIdsWithRuns } from "./store.ts";
import { tick, type TickResult } from "./tick.ts";
import { formatInZone, systemTimezone } from "./time.ts";

// `agent-tasks runner`: a plain long-lived process (doc/roadmap/runner.md).
// Loop: fresh `now` → tick → show events → notify → wait for the next
// interval. A tick that throws is shown as ⚠ and the loop goes on.

export interface RunnerOptions {
  /** Interval as written (`5m`). Fixed for the runner's life; a change in the config needs a restart. */
  every: string;
  once: boolean;
  quiet: boolean;
}

/** Where the screen output goes. `isTTY` turns on colors, the status line and the Herdr escapes. */
export type RunnerStdout = Writer & { isTTY?: boolean; columns?: number };

export interface RunnerDeps {
  /** The clock (the real time, shifted by `--now`). */
  now(): Date;
  /** Waits `ms`, returning early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A fresh context for one tick at `now` (config re-read, so notifier and task edits apply on the next tick). */
  context(now: Date): Context;
  /** Aborted on SIGINT/SIGTERM/SIGHUP: the runner stops after the current tick. */
  signal: AbortSignal;
  stdout: RunnerStdout;
  pid: number;
  /** The tick function (replaceable in tests). */
  tick?(ctx: Context): TickResult;
  notifierDeps?: NotifierDeps;
  pidAlive?(pid: number): boolean;
  /** Called once the runner holds the lock, before its first line (the command opens the dashboard here). */
  onStarted?(): void;
  /** True while the dashboard owns the screen: lines only go to runner.log (which the dashboard shows). */
  screenHidden?(): boolean;
}

/** Waits `ms` or until `signal` aborts, whichever comes first. */
export function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** `herdr (clc)`: the root launcher and agent of the config, for the header. */
function describeSetup(ctx: Context): { launcher: string; agent: string } {
  const config = ctx.config.config;
  const launcher = config.launcher ? (config.launcher.preset ?? "custom") : String(BUILTIN_DEFAULTS.launcher.preset);
  const agent = config.agent ? (typeof config.agent === "string" ? config.agent : config.agent.command) : BUILTIN_DEFAULTS.agent.command;
  return { launcher, agent };
}

/** Runs that are running or blocked, across every task (archived ones too). */
export function countRunning(ctx: Context): number {
  const ids = new Set([...listTasks(ctx.paths).items.map((t) => t.id), ...taskIdsWithRuns(ctx.paths)]);
  let running = 0;
  for (const id of ids) {
    for (const { run } of listRuns(ctx.paths, id).items) if (run.status === "running" || run.status === "blocked") running++;
  }
  return running;
}

function errorText(err: unknown): string {
  return err instanceof AgentTasksError ? err.message : String((err as Error)?.stack ?? err);
}

// ---------------------------------------------------------------------------
// Output: the screen, runner.log and the Herdr escapes
// ---------------------------------------------------------------------------

class RunnerOutput {
  readonly tty: boolean;
  readonly style: Style;
  private statusShown = false;
  private agentState: AgentState | null = null;
  private readonly plainStyle: Style = createStyle(false);

  constructor(
    private readonly stdout: RunnerStdout,
    private readonly logFile: string,
    private readonly timezone: string,
    env: Record<string, string | undefined>,
    private readonly mode: { json: boolean; quiet: boolean },
    private readonly hidden: () => boolean = () => false,
  ) {
    this.tty = stdout.isTTY === true && !mode.json;
    this.style = createStyle(this.tty && colorEnabled(stdout, env));
  }

  private write(text: string): void {
    if (this.hidden()) return;
    if (this.statusShown) {
      this.stdout.write(CLEAR_STATUS);
      this.statusShown = false;
    }
    this.stdout.write(text);
  }

  private log(text: string): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      appendFileSync(this.logFile, `${text}\n`);
    } catch {
      // runner.log is a copy of the screen; failing to write it must not stop the runner.
    }
  }

  private writeJson(json: unknown): void {
    this.stdout.write(`${JSON.stringify(json)}\n`);
  }

  /** In runner.log the header and the final line carry the time, like every other line. */
  private stamped(at: Date, text: string): string {
    return `${clockTimeWithSeconds(at, this.timezone)}  ${text}`;
  }

  header(at: Date, text: (style: Style) => string, json: unknown): void {
    this.log(this.stamped(at, text(this.plainStyle)));
    if (this.mode.json) this.writeJson(json);
    else this.write(`${text(this.style)}\n`);
  }

  /** A line in runner.log and on the screen; with --json, `json` (if any) instead of the text. */
  emit(line: RunnerLine, json?: unknown): void {
    this.log(formatLine(line, this.timezone, this.plainStyle));
    if (this.mode.json) {
      if (json !== undefined) this.writeJson(json);
      return;
    }
    if (this.mode.quiet && line.kind === "tick") return;
    this.write(`${formatLine(line, this.timezone, this.style)}\n`);
  }

  private get width(): number | undefined {
    return this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : undefined;
  }

  /** The status line, redrawn in place on a terminal only. */
  status(info: StatusInfo): void {
    if (!this.tty || this.mode.quiet || this.hidden()) return;
    this.write(formatStatusBlock(info, this.timezone, this.style, this.width));
    this.statusShown = true;
  }

  /** The last status line, on the screen and in the log. */
  final(at: Date, info: StatusInfo, json: unknown): void {
    const plain = formatStatus(info, this.timezone, this.plainStyle);
    this.log(this.stamped(at, plain));
    if (this.mode.json) return this.writeJson(json);
    if (this.mode.quiet) return;
    this.write(this.tty ? `${formatStatusBlock(info, this.timezone, this.style, this.width)}\n` : `${plain}\n`);
  }

  /** OSC 2 title and OSC 7501 agent state, only on a terminal and only when the state changes. */
  agent(state: AgentState, withTitle = false): void {
    if (!this.tty) return;
    if (withTitle) this.stdout.write(oscTitle("agent-tasks runner"));
    if (state === this.agentState) return;
    this.agentState = state;
    this.stdout.write(oscAgentState(state));
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD`, to reset the "today" counters at midnight. */
function dayOf(at: Date, timezone: string): string {
  return formatInZone(at, timezone).slice(0, 10);
}

function emptyCounts(): TodayCounts {
  return { succeeded: 0, failed: 0, missed: 0, blocked: 0 };
}

function tallyToday(today: TodayCounts, e: ExecEvent): void {
  if (e.type === "succeeded") today.succeeded++;
  else if (e.type === "failed" || e.type === "timed_out") today.failed++;
  else if (e.type === "missed") today.missed++;
  else if (e.type === "blocked") today.blocked++;
}

/** Adds how long the attempt took to a finished event. */
function withDuration(ctx: Context, e: ExecEvent): RunnerEvent {
  if (!e.run_ref || !["succeeded", "failed", "timed_out"].includes(e.type)) return e;
  try {
    const run = readRunByRef(ctx.paths, e.run_ref);
    const attempt = run.attempts[(e.attempt ?? run.attempts.length) - 1];
    if (!attempt?.finished_at) return e;
    return { ...e, duration_ms: Date.parse(attempt.finished_at) - Date.parse(attempt.started_at) };
  } catch {
    return e;
  }
}

class Runner {
  private readonly everyMs: number;
  private readonly timezone: string;
  private readonly lock: RunnerLock;
  private readonly startedAt: Date;
  private readonly status: StatusInfo = { health: "healthy", last_tick: null, next_tick: null, running: 0, today: emptyCounts() };
  private day: string;
  private ticks = 0;
  /** Anomalies notified on the previous tick: one that keeps happening is notified once, not every tick. */
  private recentAnomalies = new Set<string>();
  private out!: RunnerOutput;
  private notifierDeps!: NotifierDeps;

  constructor(
    private readonly base: Context,
    private readonly opts: RunnerOptions,
    private readonly deps: RunnerDeps,
  ) {
    this.everyMs = parseDuration(opts.every);
    this.timezone = base.config.config.timezone ?? systemTimezone();
    const startedAt = (this.startedAt = deps.now());
    this.day = dayOf(startedAt, this.timezone);
    this.lock = { pid: deps.pid, terminal: base.env.HC_TERMINAL_ID || null, started_at: formatInZone(startedAt, this.timezone), every: opts.every, last_tick_at: null, next_tick_at: null };
  }

  /** Timestamps in JSON output, in the same format as the tick's `at`. */
  private stamp(at: Date): string {
    return formatInZone(at, this.timezone);
  }

  private get paths() {
    return this.base.paths;
  }

  private warn(at: Date, message: string): void {
    this.out.emit({ kind: "warning", at, message }, { type: "warning", at: this.stamp(at), message });
  }

  private notify(ctx: Context, items: NotifyItem[]): void {
    if (items.length === 0) return;
    try {
      for (const w of dispatchNotifications(ctx, items, this.notifierDeps).warnings) this.warn(ctx.now, w);
    } catch (err) {
      this.warn(ctx.now, `notifiers failed: ${errorText(err)}`);
    }
  }

  /** Drops anomalies already notified on the previous tick (anomalies have no run event to mark). */
  private freshAnomalies(items: NotifyItem[]): NotifyItem[] {
    const key = (i: NotifyItem) => `${i.task_id ?? ""}|${i.run_ref ?? ""}|${i.message ?? ""}`;
    const seen = this.recentAnomalies;
    this.recentAnomalies = new Set(items.filter((i) => i.type === "anomaly").map(key));
    return items.filter((i) => i.type !== "anomaly" || !seen.has(key(i)));
  }

  async run(): Promise<number> {
    const { startedAt } = this;
    // Read before the first tick appends its heartbeat.
    const previousTick = lastTick(this.paths);
    this.out = new RunnerOutput(this.deps.stdout, runnerLogPath(this.paths), this.timezone, this.base.env, { json: this.base.json, quiet: this.opts.quiet }, this.deps.screenHidden);
    this.notifierDeps = this.deps.notifierDeps ?? defaultNotifierDeps(this.base.env);
    const setup = describeSetup(this.base);
    const { stale } = acquireRunnerLock(this.paths, this.lock, this.deps.pidAlive ?? pidAlive);

    let exitCode = 0;
    try {
      this.deps.onStarted?.();
      const header = { every: this.opts.every, ...setup, dataDir: tildify(this.paths.dataDir, this.base.env) };
      this.out.header(startedAt, (style) => formatHeader(header, style), { type: "runner_started", pid: this.lock.pid, terminal: this.lock.terminal, started_at: this.lock.started_at, every: this.opts.every, ...setup, data_dir: this.paths.dataDir });
      this.out.agent("idle", true);
      if (stale) this.warn(startedAt, `took over a stale lock from pid ${stale.pid} (started ${stale.started_at})`);
      // `--once` is for testing and for schedulers that call it at their own pace: no gap to report.
      if (previousTick && !this.opts.once) this.reportGap(startedAt, previousTick.at);

      while (!this.deps.signal.aborted) {
        const at = this.deps.now();
        if (!this.tickOnce(at) && this.opts.once) exitCode = 1;
        if (this.opts.once) break;
        this.out.status(this.status);
        await this.deps.sleep(Math.max(0, this.status.next_tick!.getTime() - this.deps.now().getTime()), this.deps.signal);
      }
    } finally {
      releaseRunnerLock(this.paths, this.lock.pid);
      const final: StatusInfo = { ...this.status, health: this.opts.once ? this.status.health : "stopped", next_tick: null };
      const stoppedAt = this.deps.now();
      this.out.final(stoppedAt, final, { type: "runner_stopped", at: this.stamp(stoppedAt), ticks: this.ticks, last_tick: this.status.last_tick ? this.stamp(this.status.last_tick) : null, running: this.status.running, today: this.status.today });
    }
    return exitCode;
  }

  /** The heartbeat came back after a gap: say how long nothing ticked. */
  private reportGap(startedAt: Date, lastTickAt: string): void {
    const last = new Date(lastTickAt);
    const gap = startedAt.getTime() - last.getTime();
    if (gap <= 2 * this.everyMs) return;
    this.out.emit({ kind: "recovered", at: startedAt, last_tick: last, gap_ms: gap }, { type: "runner_recovered", at: this.stamp(startedAt), last_tick: lastTickAt, gap_ms: gap });
    try {
      this.notify(this.deps.context(startedAt), [{ type: "runner_recovered", run_ref: null, task_id: null, message: `no ticks for ${formatDuration(gap)} (last tick ${lastTickAt})` }]);
    } catch (err) {
      this.warn(startedAt, `notifiers failed: ${errorText(err)}`);
    }
  }

  /** One tick: run it, show and notify its events, update the lock. Returns false when the tick threw. */
  private tickOnce(at: Date): boolean {
    const { status } = this;
    if (dayOf(at, this.timezone) !== this.day) {
      this.day = dayOf(at, this.timezone);
      status.today = emptyCounts();
    }
    this.ticks++;
    let ok = true;
    try {
      const ctx = this.deps.context(at);
      const result = (this.deps.tick ?? ((c: Context) => tick(c, { mode: "runner" })))(ctx);
      const events = result.events.map((e) => withDuration(ctx, e));
      status.running = countRunning(ctx);
      const due = events.filter((e) => e.type === "launched" || (e.type === "failed" && e.reason === "launch_failed")).length;
      this.out.emit({ kind: "tick", at, due, running: status.running }, { type: "tick", at: result.at, mode: result.mode, events, errors: result.errors, running: status.running });
      for (const event of events) {
        this.out.emit({ kind: "event", at, event });
        tallyToday(status.today, event);
      }
      this.notify(ctx, this.freshAnomalies(events.filter(isNotifyItem)));
      status.health = result.errors.length > 0 ? "degraded" : "healthy";
    } catch (err) {
      ok = false;
      status.health = "tick_failed";
      this.warn(at, `tick failed: ${errorText(err)}`);
    }
    status.last_tick = at;
    status.next_tick = this.opts.once ? null : new Date(at.getTime() + this.everyMs);
    this.out.agent(status.running > 0 ? "working" : "idle");
    try {
      updateRunnerLock(this.paths, { ...this.lock, last_tick_at: formatInZone(at, this.timezone), next_tick_at: status.next_tick ? formatInZone(status.next_tick, this.timezone) : null });
    } catch (err) {
      this.warn(at, `could not update the runner lock: ${errorText(err)}`);
    }
    return ok;
  }
}

/**
 * Runs the loop until `deps.signal` aborts (or once with `--once`). Returns
 * the exit code: 0, or 1 when the single `--once` tick failed. Throws
 * `RunnerLockedError` when another runner is alive.
 */
export function runRunner(base: Context, opts: RunnerOptions, deps: RunnerDeps): Promise<number> {
  return new Runner(base, opts, deps).run();
}
