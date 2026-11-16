import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { Context } from "./context.ts";
import { lastAttempt, readRunRef, requireTask, sessionFor } from "./execution.ts";
import { readSession } from "./launcher.ts";
import { stdoutStyle, type Style } from "./output/style.ts";
import { statusLabel } from "./output/symbols.ts";
import { isInProgress } from "./run-info.ts";
import type { Run } from "./schema.ts";
import { withSigint } from "./sigint.ts";

// `log --follow`: polls the run's output and prints what is new until the run
// is final. The output comes from the launcher's `read` (a screen or a tail:
// compared line by line with what was already printed) or, when the launcher
// has none or the session can no longer be read, from the attempt's log file
// (read from where the last poll stopped).

const FOLLOW_INTERVAL_MS = 2_000;
/** Consecutive polls without readable output before saying so on stderr. */
const UNREADABLE_POLLS_NOTE = 3;
/** Exit code after Ctrl+C, as shells report a SIGINT. */
export const EXIT_INTERRUPTED = 130;

export interface FollowOptions {
  /** Waits between polls; tests pass one that changes the run instead of sleeping. */
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Aborted on Ctrl+C: stops at the next poll without printing the final line. */
  signal?: AbortSignal;
  /** The captured log the caller already printed for the latest attempt. */
  shown: string;
  /** Only the output, without attempt separators or the final status line (`--raw`). */
  raw?: boolean;
  /** Print nothing: only wait for the run to be final (`--json`). */
  quiet?: boolean;
  style: Style;
}

export interface FollowResult {
  run: Run;
  /** False when interrupted before the run reached a final status. */
  finished: boolean;
}

function lines(text: string): string[] {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed === "" ? [] : trimmed.split("\n").map((l) => l.replace(/\s+$/, ""));
}

/**
 * The lines of `next` that come after what was already shown: the longest
 * suffix of `shown` that is also a prefix of `next` is skipped. When nothing
 * overlaps (the screen was redrawn in place), only the lines that weren't in
 * `previous` (the last snapshot) are new, so a spinner doesn't reprint it all.
 */
export function newLines(shown: readonly string[], next: readonly string[], previous: readonly string[] = []): string[] {
  for (let k = Math.min(shown.length, next.length); k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (shown[shown.length - k + i] !== next[i]) {
        match = false;
        break;
      }
    }
    if (match) return next.slice(k);
  }
  const seen = new Set(previous);
  return next.filter((l) => !seen.has(l));
}

/** Reads a file from a byte offset; returns the complete lines and where they end. */
function readFrom(path: string, offset: number, all: boolean): { text: string; offset: number } {
  if (!existsSync(path)) return { text: "", offset };
  const size = statSync(path).size;
  if (size < offset) offset = 0; // truncated or replaced
  if (size === offset) return { text: "", offset };
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  // Hold back an unterminated last line until it is complete (or the run is over).
  const end = all ? buffer.length : buffer.lastIndexOf(0x0a) + 1;
  return { text: buffer.subarray(0, end).toString("utf8"), offset: offset + end };
}

/** Where the output of one attempt comes from, and what of it was printed. */
class AttemptOutput {
  private shown: string[];
  private previous: string[] = [];
  private offset: number;

  constructor(
    private readonly ctx: Context,
    readonly attempt: number,
    shown: string,
  ) {
    this.shown = lines(shown);
    this.offset = Buffer.byteLength(shown);
  }

  /** New text, or null when nothing could be read. `final`: the run is over, take everything. */
  poll(run: Run, final: boolean): string | null {
    const task = requireTask(this.ctx, run.task_id);
    const session = sessionFor(this.ctx, task, this.ctx.resolveFor(task), run);
    if (!session) return null;
    if (session.spec.read) {
      let screen: string | null = null;
      try {
        screen = readSession(session.spec, session.input);
      } catch {
        // The session may have just ended; its last screen may be in the log file.
      }
      if (screen !== null) return this.fromScreen(final || screen.endsWith("\n") ? screen : screen.slice(0, screen.lastIndexOf("\n") + 1));
      if (!final) return null;
    }
    const chunk = readFrom(session.input.logPath, session.spec.read ? 0 : this.offset, final);
    // The last screen captured into the log when the session was closed (see `captureLog`).
    if (session.spec.read) return this.fromScreen(chunk.text.split(/^--- session output \(.*\) ---\n/m).at(-1)!);
    this.offset = chunk.offset;
    return chunk.text === "" ? "" : chunk.text.replace(/\n$/, "");
  }

  private fromScreen(text: string): string {
    const next = lines(text);
    const fresh = newLines(this.shown, next, this.previous);
    this.previous = next;
    // Only the tail can overlap with a screen of next.length lines.
    this.shown = [...this.shown, ...fresh].slice(-Math.max(next.length, 1));
    return fresh.join("\n");
  }
}

function finalLine(style: Style, run: Run, ref: string): string {
  const summary = lastAttempt(run)?.summary;
  return `${statusLabel(style, run.status)}  ${style.paint("bold", ref)}${run.reason ? ` · reason ${run.reason}` : ""}${summary ? ` · ${summary}` : ""}`;
}

/**
 * Prints new output of a running or blocked run until it reaches a final
 * status, then (unless `raw`) its final status line.
 */
export async function followRun(ctx: Context, ref: string, opts: FollowOptions): Promise<FollowResult> {
  const interval = opts.intervalMs ?? FOLLOW_INTERVAL_MS;
  let run = readRunRef(ctx, ref);
  let output = new AttemptOutput(ctx, lastAttempt(run)?.n ?? 0, opts.shown);
  let unreadable = 0;
  const print = (text: string) => {
    if (!opts.quiet) ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  while (isInProgress(run.status)) {
    if (opts.signal?.aborted) return { run, finished: false };
    await opts.sleep(interval);
    if (opts.signal?.aborted) return { run, finished: false };
    run = readRunRef(ctx, ref);
    if (opts.quiet) continue;
    const n = lastAttempt(run)?.n ?? 0;
    if (n !== output.attempt) {
      output = new AttemptOutput(ctx, n, "");
      if (!opts.raw) print(`\n--- attempt ${n} ---`);
    }
    const text = output.poll(run, !isInProgress(run.status));
    if (text) print(text);
    unreadable = text === null ? unreadable + 1 : 0;
    if (unreadable === UNREADABLE_POLLS_NOTE) ctx.stderr.write(`agent-tasks: the session of ${ref} can't be read right now; waiting for the run to finish\n`);
  }
  if (!opts.raw) print(`\n${finalLine(opts.style, run, ref)}`);
  return { run, finished: true };
}

/** A sleep that resolves early when the signal is aborted. */
export function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done);
    });
}

/** Follows with the real clock until the run is final or Ctrl+C. */
export function followWithClock(ctx: Context, ref: string, opts: Pick<FollowOptions, "shown" | "raw" | "quiet">): Promise<FollowResult> {
  const controller = new AbortController();
  return withSigint(
    () => controller.abort(),
    () => followRun(ctx, ref, { ...opts, sleep: abortableSleep(controller.signal), signal: controller.signal, style: stdoutStyle(ctx) }),
  );
}
