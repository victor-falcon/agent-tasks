import { writeSync } from "node:fs";
import type { Context, Writer } from "../context.ts";
import { abortableSleep, followRun } from "../follow.ts";
import { capturedLog, renderRunLog } from "../output/run-log.ts";
import { createStyle, type Style } from "../output/style.ts";
import { isInProgress } from "../run-info.ts";
import { formatLine, type RunnerLine, type StatusInfo } from "../runner-render.ts";
import { readRunByRef } from "../store.ts";
import { ENTER_SCREEN, LEAVE_SCREEN, lineAt, sanitize } from "./ansi.ts";
import { emptyData, loadData, type TuiData } from "./data.ts";
import { parseKeys } from "./keys.ts";
import { type Effect, flash, initialModel, type Model, reanchor, update } from "./model.ts";
import { type LogContent, render, rowRefs, type ViewInput, viewBounds } from "./render.ts";

// The IO around the pure model and renderer: raw keys from stdin, the
// alternate screen, timers, resize, the runner's events and the log view.
// Everything the terminal was put into is undone on close, on exit and on
// a crash.

/** Redraws this often, so relative times and the bottom line stay current. */
const REDRAW_MS = 1_000;
/** Re-reads the data folder this often, to show runs that finished between ticks. */
const RELOAD_MS = 5_000;

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
  env: Record<string, string | undefined>;
  every: string;
  now(): Date;
  /** A fresh context at `now`, to read the data folder. */
  context(now: Date): Context;
  /** `q` or Ctrl-C: stop the runner after the current tick (the same as the signal handler). */
  onQuit(): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RunnerTui {
  private model: Model = initialModel();
  private data: TuiData = emptyData();
  private status: StatusInfo = { health: "healthy", last_tick: null, next_tick: null, running: 0, today: { succeeded: 0, failed: 0, missed: 0, blocked: 0 } };
  private log: (LogContent & { lines: string[] }) | null = null;
  private logStop: AbortController | null = null;
  private previous: string[] = [];
  private previousSize = "";
  private timers: ReturnType<typeof setInterval>[] = [];
  private active = false;
  private readonly style: Style;

  constructor(private readonly opts: RunnerTuiOptions) {
    this.style = createStyle(opts.env.NO_COLOR === undefined || opts.env.NO_COLOR === "");
  }

  private readonly onData = (chunk: Buffer | string) => {
    for (const key of parseKeys(chunk.toString())) this.key(key);
  };
  private readonly onResize = () => this.draw(true);
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
    this.reload();
    this.timers.push(setInterval(() => this.draw(), REDRAW_MS), setInterval(() => this.reload(), RELOAD_MS));
    for (const t of this.timers) (t as { unref?: () => void }).unref?.();
    this.draw(true);
  }

  /** A runner line (tick, event, warning): events show on the bottom line for a while. */
  line(line: RunnerLine): void {
    if (!this.active) return;
    if (line.kind !== "tick") {
      const text = formatLine(line, this.data.timezone, this.style).replace(/ {3,}/g, "  ");
      this.model = flash(this.model, text, this.opts.now().getTime());
    }
    this.draw();
  }

  /** After each tick: the runner's state for the header, and fresh data. */
  updateStatus(info: StatusInfo): void {
    this.status = { ...info, today: { ...info.today } };
    if (!this.active) return;
    this.reload();
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
    const fd = this.opts.stdout.fd ?? 1;
    try {
      writeSync(fd, LEAVE_SCREEN);
    } catch {
      this.opts.stdout.write(LEAVE_SCREEN);
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

  private reload(): void {
    const now = this.opts.now();
    try {
      const data = loadData(this.opts.context(now));
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
    if (effect.type === "quit") this.opts.onQuit();
    else if (effect.type === "open-log") this.openLog(effect.ref);
    else this.closeLog();
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
    // A run in progress opens at its latest output and sticks to it.
    if (this.model.log) this.model = { ...this.model, log: { ...this.model.log, follow: true } };

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
