import { writeSync } from "node:fs";
import type { Context, Writer } from "../context.ts";
import { abortableSleep, followRun } from "../follow.ts";
import { capturedLog, renderRunLog } from "../output/run-log.ts";
import { colorEnabled, createStyle, type Style } from "../output/style.ts";
import { isInProgress } from "../run-info.ts";
import { formatLine, type RunnerLine, type StatusInfo } from "../runner-render.ts";
import { readRunByRef } from "../store.ts";
import { ENTER_SCREEN, LEAVE_SCREEN, lineAt, sanitize } from "./ansi.ts";
import { dataStamp, emptyData, loadData, type TuiData } from "./data.ts";
import { parseKeys } from "./keys.ts";
import { type Effect, flash, followLog, initialModel, type Model, reanchor, update } from "./model.ts";
import { type LogContent, render, rowRefs, type ViewInput, viewBounds } from "./render.ts";

// The IO around the pure model and renderer: raw keys from stdin, the
// alternate screen, timers, resize, the runner's events and the log view.
// Everything the terminal was put into is undone on close, on exit and on
// a crash.

/** Redraws this often, so relative times and the bottom line stay current. */
const REDRAW_MS = 1_000;
/** Lines the log view keeps while following a long run (the oldest are dropped). */
const LOG_MAX_LINES = 20_000;
/** Checks this often whether the data folder changed (runs that finished between ticks). */
const CHECK_MS = 2_000;
/** Re-reads the data folder at least this often, so upcoming slots that passed drop off. */
const RELOAD_MS = 60_000;

export interface TerminalIn {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding?(encoding: "utf8"): unknown;
}

export type TerminalOut = Writer & { columns?: number; rows?: number; fd?: number };

export interface RunnerTuiOptions {
  stdin: TerminalIn;
  stdout: TerminalOut;
  /** Where a crash of the view is reported (after the screen is restored). */
  stderr: Writer;
  env: Record<string, string | undefined>;
  every: string;
  now(): Date;
  /** A fresh context at `now`, to read the data folder. */
  context(now: Date): Context;
  /** `q` or Ctrl-C: stop the runner after the current tick (the same as the signal handler). */
  onQuit(): void;
}

function emptyStatus(): StatusInfo {
  return { health: "healthy", last_tick: null, next_tick: null, running: 0, today: { succeeded: 0, failed: 0, missed: 0, blocked: 0 } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RunnerTui {
  private model: Model = initialModel();
  private data: TuiData = emptyData();
  private status: StatusInfo = emptyStatus();
  private stamp = "";
  private loadedAt = 0;
  private log: (LogContent & { lines: string[] }) | null = null;
  private logStop: AbortController | null = null;
  private previous: string[] = [];
  private previousSize = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private active = false;
  private readonly style: Style;

  constructor(private readonly opts: RunnerTuiOptions) {
    this.style = createStyle(colorEnabled(opts.stdout, opts.env));
  }

  private readonly onData = (chunk: Buffer | string) => this.guard(() => {
    for (const key of parseKeys(chunk.toString())) this.key(key);
  });
  private readonly onResize = () => this.guard(() => this.draw(true));
  private readonly onExit = () => this.restore();

  start(): void {
    if (this.active) return;
    this.active = true;
    const { stdin } = this.opts;
    stdin.setRawMode?.(true);
    stdin.setEncoding?.("utf8");
    stdin.on("data", this.onData);
    stdin.resume();
    process.on("SIGWINCH", this.onResize);
    process.on("exit", this.onExit);
    this.opts.stdout.write(ENTER_SCREEN);
    this.guard(() => this.reload());
    this.timers.push(
      setInterval(() => this.guard(() => this.draw()), REDRAW_MS),
      setInterval(() => this.guard(() => this.reloadIfChanged()), CHECK_MS),
    );
    for (const t of this.timers) t.unref();
    this.guard(() => this.draw(true));
  }

  /**
   * Runs a piece of the view. A bug in it must not take the scheduler down:
   * the view closes, says why on stderr, and the runner carries on (its
   * events still go to state/runner.log).
   */
  private guard(fn: () => void): void {
    if (!this.active) return;
    try {
      fn();
    } catch (err) {
      this.close();
      this.opts.stderr.write(`agent-tasks: the runner's view stopped: ${(err as Error)?.stack ?? err}\nThe runner keeps going; its events are in state/runner.log. Restart it with --plain for line output.\n`);
    }
  }

  /** A runner line (tick, event, warning): events show on the bottom line for a while. */
  line(line: RunnerLine): void {
    if (!this.active) return;
    if (line.kind !== "tick") {
      const text = formatLine(line, this.data.timezone, this.style).replace(/ {3,}/g, "  ");
      this.model = flash(this.model, text, this.opts.now().getTime());
    }
    this.guard(() => this.draw());
  }

  /** After each tick: the runner's state for the header, and fresh data. */
  updateStatus(info: StatusInfo): void {
    this.status = { ...info, today: { ...info.today } };
    this.guard(() => this.reloadIfChanged(true));
  }

  /** Leaves the alternate screen and gives the terminal back. Safe to call twice. */
  close(): void {
    if (!this.active) return;
    this.closeLog();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const { stdin } = this.opts;
    stdin.off("data", this.onData);
    stdin.pause();
    process.off("SIGWINCH", this.onResize);
    process.off("exit", this.onExit);
    this.restore();
  }

  /** Synchronous, so it also works from an `exit` handler. */
  private restore(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.opts.stdin.setRawMode?.(false);
    } catch {
      // stdin may already be closed.
    }
    // Written straight to the file descriptor when there is one: an `exit` handler can't wait for a stream.
    const { fd } = this.opts.stdout;
    try {
      if (fd === undefined) this.opts.stdout.write(LEAVE_SCREEN);
      else writeSync(fd, LEAVE_SCREEN);
    } catch {
      // The terminal is gone.
    }
  }

  private input(): ViewInput {
    const { columns, rows } = this.opts.stdout;
    return {
      model: this.model,
      data: this.data,
      runner: { every: this.opts.every, status: this.status },
      log: this.log,
      size: { width: columns && columns > 0 ? columns : 80, height: rows && rows > 0 ? rows : 24 },
      now: this.opts.now(),
      style: this.style,
    };
  }

  /** Re-reads the data when a run or task changed, or the last read is old. `redraw`: draw anyway (the header changed). */
  private reloadIfChanged(redraw = false): void {
    const now = this.opts.now();
    try {
      const stamp = dataStamp(this.opts.context(now).paths);
      if (stamp === this.stamp && now.getTime() - this.loadedAt < RELOAD_MS) {
        if (redraw) this.draw();
        return;
      }
    } catch {
      // Let reload() report it.
    }
    this.reload();
  }

  private reload(): void {
    const now = this.opts.now();
    try {
      const ctx = this.opts.context(now);
      this.stamp = dataStamp(ctx.paths);
      this.loadedAt = now.getTime();
      const data = loadData(ctx);
      this.model = reanchor(this.model, rowRefs(this.data), rowRefs(data));
      this.data = data;
    } catch (err) {
      this.model = flash(this.model, `⚠ could not read the data folder: ${errorMessage(err)}`, now.getTime());
    }
    this.draw();
  }

  private key(key: string): void {
    const result = update(this.model, key, viewBounds(this.input()));
    this.model = result.model;
    for (const effect of result.effects) this.apply(effect);
    this.draw();
  }

  private apply(effect: Effect): void {
    switch (effect.type) {
      case "quit":
        return this.opts.onQuit();
      case "open-log":
        return this.openLog(effect.ref);
      case "close-log":
        return this.closeLog();
      case "redraw":
        return this.draw(true);
      case "notice":
        this.model = flash(this.model, effect.text, this.opts.now().getTime());
        return;
    }
  }

  private openLog(ref: string): void {
    this.closeLog();
    const ctx = this.opts.context(this.opts.now());
    let run;
    try {
      run = readRunByRef(ctx.paths, ref);
    } catch (err) {
      this.log = { lines: [`could not read ${ref}: ${errorMessage(err)}`], following: false };
      return;
    }
    const captured = capturedLog(ctx, run, run.attempts.at(-1));
    this.log = { lines: sanitize(renderRunLog(ctx, this.style, run, run.attempts, captured)), following: isInProgress(run.status) };
    if (!this.log.following) return;
    this.model = followLog(this.model);

    // Live output: the same polling as `log --follow`, printed into the view instead of stdout.
    const controller = (this.logStop = new AbortController());
    const log = this.log;
    const into: Writer = { write: (text) => this.appendLog(log, text) };
    const followCtx: Context = { ...ctx, stdout: into, stderr: into };
    followRun(followCtx, ref, { sleep: abortableSleep(controller.signal), signal: controller.signal, shown: captured?.content ?? "", style: this.style })
      .catch((err) => this.appendLog(log, `⚠ stopped following: ${errorMessage(err)}\n`))
      .finally(() => {
        log.following = false;
        this.draw();
      });
  }

  private appendLog(log: { lines: string[] }, text: string): void {
    log.lines.push(...sanitize(text.replace(/\n$/, "")));
    if (log.lines.length > LOG_MAX_LINES) log.lines.splice(0, log.lines.length - LOG_MAX_LINES);
    if (this.log === log) this.draw();
  }

  private closeLog(): void {
    this.logStop?.abort();
    this.logStop = null;
    this.log = null;
  }

  /** Writes only the lines that changed (all of them after a resize). */
  private draw(full = false): void {
    if (!this.active) return;
    const input = this.input();
    const size = `${input.size.width}x${input.size.height}`;
    if (size !== this.previousSize) {
      full = true;
      this.previousSize = size;
    }
    const lines = render(input);
    let out = full ? "\x1b[2J" : "";
    lines.forEach((line, i) => {
      if (full || this.previous[i] !== line) out += lineAt(i, line);
    });
    this.previous = lines;
    if (out) this.opts.stdout.write(out);
  }
}
