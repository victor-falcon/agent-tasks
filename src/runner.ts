import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_DEFAULTS } from "./config.ts";
import type { Context, Writer } from "./context.ts";
import { formatDuration, parseDuration } from "./duration.ts";
import { AgentTasksError } from "./errors.ts";
import type { ExecEvent } from "./execution.ts";
import { defaultNotifierDeps, dispatchNotifications, type NotifierDeps, type NotifyItem } from "./notifiers/index.ts";
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
  type Style,
  type TodayCounts,
  useColor,
} from "./runner-render.ts";
import { listRuns, listTasks, readRunByRef, readTicks, taskIdsWithRuns } from "./store.ts";
import { tick, type TickResult } from "./tick.ts";
import { formatInZone, systemTimezone } from "./time.ts";

// `agent-tasks runner`: a plain long-lived process (doc/roadmap/runner.md).
// Loop: fresh `now` → tick → show events → notify → wait for the next
// interval. A tick that throws is shown as ⚠ and the loop goes on.

export interface RunnerOptions {
  /** Interval as written (`5m`). */
  every: string;
  once: boolean;
  quiet: boolean;
}

export interface RunnerDeps {
  /** The clock (the real time, shifted by `--now`). */
  now(): Date;
  /** Waits `ms`, returning early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** A fresh context for one tick at `now` (config re-read, so edits apply on the next tick). */
  context(now: Date): Context;
  /** Aborted on SIGINT/SIGTERM: the runner stops after the current tick. */
  signal: AbortSignal;
  /** Where the screen output goes. `isTTY` turns on colors, the status line and the Herdr escapes. */
  stdout: Writer & { isTTY?: boolean };
  pid: number;
  /** The tick function (replaceable in tests). */
  tick?(ctx: Context): TickResult;
  notifierDeps?: NotifierDeps;
  pidAlive?(pid: number): boolean;
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

const NOTIFIABLE = new Set(["launched", "succeeded", "failed", "timed_out", "missed", "blocked", "anomaly"]);

function errorText(err: unknown): string {
  return err instanceof AgentTasksError ? err.message : String((err as Error)?.stack ?? err);
}

/** The screen, `runner.log` and the Herdr escapes. */
class RunnerOutput {
  readonly tty: boolean;
  readonly style: Style;
  private statusShown = false;
  private agentState: AgentState | null = null;

  constructor(
    private readonly stdout: Writer & { isTTY?: boolean },
    private readonly logFile: string,
    private readonly timezone: string,
    env: Record<string, string | undefined>,
    private readonly json: boolean,
    private readonly quiet: boolean,
  ) {
    this.tty = stdout.isTTY === true && !json;
    this.style = { color: useColor(this.tty, env) };
  }

  private write(text: string): void {
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

  /** A line on the screen (unless JSON) and in runner.log. */
  line(screen: string, plain: string, json?: unknown): void {
    if (this.json) {
      if (json !== undefined) this.stdout.write(`${JSON.stringify(json)}\n`);
    } else this.write(`${screen}\n`);
    this.log(plain);
  }

  runnerLine(line: RunnerLine, json: unknown): void {
    if (this.quiet && line.kind === "tick") {
      this.log(formatLine(line, this.timezone, { color: false }));
      return;
    }
    this.line(formatLine(line, this.timezone, this.style), formatLine(line, this.timezone, { color: false }), json);
  }

  header(text: (style: Style) => string, json: unknown): void {
    this.line(text(this.style), text({ color: false }), json);
  }

  /** The status line, redrawn in place on a terminal only. */
  status(info: StatusInfo): void {
    if (!this.tty || this.quiet) return;
    this.write(formatStatusBlock(info, this.timezone, this.style));
    this.statusShown = true;
  }

  /** The final status line, on the screen and in the log. */
  final(info: StatusInfo, json: unknown): void {
    const plain = formatStatus(info, this.timezone, { color: false });
    if (this.json) this.stdout.write(`${JSON.stringify(json)}\n`);
    else if (this.quiet) {
      // Events only.
    } else if (this.tty) this.write(`${formatStatusBlock(info, this.timezone, this.style)}\n`);
    else this.stdout.write(`${plain}\n`);
    this.log(plain);
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

/** Local `YYYY-MM-DD`, to reset the "today" counters at midnight. */
function dayOf(at: Date, timezone: string): string {
  return formatInZone(at, timezone).slice(0, 10);
}

/**
 * Runs the loop until `deps.signal` aborts (or once with `--once`). Returns
 * the exit code: 0, or 1 when the single `--once` tick failed.
 */
export async function runRunner(base: Context, opts: RunnerOptions, deps: RunnerDeps): Promise<number> {
  const everyMs = parseDuration(opts.every);
  const tickFn = deps.tick ?? ((ctx: Context) => tick(ctx, { mode: "runner" }));
  const timezone = base.config.config.timezone ?? systemTimezone();
  const paths = base.paths;
  const startedAt = deps.now();
  const lock: RunnerLock = {
    pid: deps.pid,
    terminal: base.env.HC_TERMINAL_ID || null,
    started_at: formatInZone(startedAt, timezone),
    every: opts.every,
    last_tick_at: null,
    next_tick_at: null,
  };
  // Read before the first tick appends its heartbeat.
  const previousTick = readTicks(paths).items.at(-1);
  const { stale } = acquireRunnerLock(paths, lock, deps.pidAlive ?? pidAlive);

  const out = new RunnerOutput(deps.stdout, runnerLogPath(paths), timezone, base.env, base.json, opts.quiet);
  const setup = describeSetup(base);
  const header = { every: opts.every, launcher: setup.launcher, agent: setup.agent, dataDir: tildify(paths.dataDir, base.env) };
  const notifierDeps = deps.notifierDeps ?? defaultNotifierDeps(base.env);

  let today: TodayCounts = { succeeded: 0, failed: 0, missed: 0, blocked: 0 };
  let day = dayOf(startedAt, timezone);
  const status: StatusInfo = { health: "healthy", last_tick: null, next_tick: null, running: 0, today };
  let exitCode = 0;
  let ticks = 0;

  const warn = (at: Date, message: string) => out.runnerLine({ kind: "warning", at, message }, { type: "warning", at: at.toISOString(), message });
  const notify = (ctx: Context, items: NotifyItem[]) => {
    if (items.length === 0) return;
    try {
      for (const w of dispatchNotifications(ctx, items, notifierDeps).warnings) warn(ctx.now, w);
    } catch (err) {
      warn(ctx.now, `notifiers failed: ${errorText(err)}`);
    }
  };

  try {
    out.header((style) => formatHeader(header, style), { type: "runner_started", pid: deps.pid, terminal: lock.terminal, started_at: lock.started_at, every: opts.every, ...setup, data_dir: paths.dataDir });
    out.agent("idle", true);
    if (stale) warn(startedAt, `took over a stale lock from pid ${stale.pid} (started ${stale.started_at})`);

    // The heartbeat came back after a gap: say how long nothing ticked.
    if (previousTick) {
      const last = new Date(previousTick.at);
      const gap = startedAt.getTime() - last.getTime();
      if (gap > 2 * everyMs) {
        out.runnerLine({ kind: "recovered", at: startedAt, last_tick: last, gap_ms: gap }, { type: "runner_recovered", at: startedAt.toISOString(), last_tick: previousTick.at, gap_ms: gap });
        const ctx = deps.context(startedAt);
        notify(ctx, [{ type: "runner_recovered", run_ref: null, task_id: null, message: `no ticks for ${formatDuration(gap)} (last tick ${previousTick.at})` }]);
      }
    }

    while (!deps.signal.aborted) {
      const at = deps.now();
      if (dayOf(at, timezone) !== day) {
        day = dayOf(at, timezone);
        today = { succeeded: 0, failed: 0, missed: 0, blocked: 0 };
        status.today = today;
      }
      ticks++;
      let ctx: Context | null = null;
      try {
        ctx = deps.context(at);
        const result = tickFn(ctx);
        const events = result.events.map((e) => withDuration(ctx!, e));
        status.running = countRunning(ctx);
        const due = result.events.filter((e) => e.type === "launched" || (e.type === "failed" && e.reason === "launch_failed")).length;
        out.runnerLine({ kind: "tick", at, due, running: status.running }, { type: "tick", at: result.at, mode: result.mode, events, errors: result.errors, running: status.running });
        for (const event of events) {
          out.runnerLine({ kind: "event", at, event }, undefined);
          count(today, event);
        }
        notify(ctx, events.filter((e) => NOTIFIABLE.has(e.type)) as NotifyItem[]);
        status.health = result.errors.length > 0 ? "degraded" : "healthy";
      } catch (err) {
        status.health = "tick_failed";
        warn(at, `tick failed: ${errorText(err)}`);
        if (opts.once) exitCode = 1;
      }
      status.last_tick = at;
      status.next_tick = opts.once ? null : new Date(at.getTime() + everyMs);
      out.agent(status.running > 0 ? "working" : "idle");
      try {
        updateRunnerLock(paths, { ...lock, last_tick_at: formatInZone(at, timezone), next_tick_at: status.next_tick ? formatInZone(status.next_tick, timezone) : null });
      } catch (err) {
        warn(at, `could not update ${paths.stateDir}/runner.lock: ${errorText(err)}`);
      }
      if (opts.once) break;
      out.status(status);
      await deps.sleep(Math.max(0, status.next_tick!.getTime() - deps.now().getTime()), deps.signal);
    }
  } finally {
    releaseRunnerLock(paths, deps.pid);
    const final: StatusInfo = { ...status, health: opts.once ? status.health : "stopped", next_tick: null };
    out.final(final, { type: "runner_stopped", at: deps.now().toISOString(), ticks, last_tick: status.last_tick?.toISOString() ?? null, running: status.running, today });
  }
  return exitCode;
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

function count(today: TodayCounts, e: ExecEvent): void {
  if (e.type === "succeeded") today.succeeded++;
  else if (e.type === "failed" || e.type === "timed_out") today.failed++;
  else if (e.type === "missed") today.missed++;
  else if (e.type === "blocked") today.blocked++;
}
