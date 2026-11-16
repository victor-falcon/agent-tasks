import { existsSync, readFileSync } from "node:fs";
import type { Context } from "./context.ts";
import { lastAttempt, readRunRef, requireTask, sessionFor } from "./execution.ts";
import { readSession } from "./launcher.ts";
import { statusLabel } from "./output/symbols.ts";
import type { Style } from "./output/style.ts";
import { isInProgress } from "./run-info.ts";
import type { Run } from "./schema.ts";

// `log --follow`: polls the launcher's `read` (or the attempt's log file when
// the launcher has none) and prints what is new, until the run is final.
// The output is compared line by line with what was already printed, so a
// screen that scrolled prints only its new lines.

export const FOLLOW_INTERVAL_MS = 2_000;

export interface FollowOptions {
  /** Waits between polls; tests pass one that changes the run instead of sleeping. */
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Aborted on Ctrl+C: stops at the next poll without printing the final line. */
  signal?: AbortSignal;
  /** The text the caller already printed for the latest attempt (its captured log). */
  shown: string;
  /** Only the output, without attempt separators or the final status line (`--raw`). */
  raw?: boolean;
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
 * overlaps (the screen was redrawn), all of `next` is new.
 */
export function newLines(shown: readonly string[], next: readonly string[]): string[] {
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
  return [...next];
}

/**
 * The current output of the run's latest attempt: the launcher's `read`, or
 * the attempt's log file when the launcher has none. Null when it can't be
 * read right now (e.g. the session just ended).
 */
function currentOutput(ctx: Context, run: Run): string | null {
  const task = requireTask(ctx, run.task_id);
  const session = sessionFor(ctx, task, ctx.resolveFor(task), run);
  if (!session) return null;
  if (session.spec.read) {
    try {
      return readSession(session.spec, session.input);
    } catch {
      return null;
    }
  }
  const path = session.input.logPath;
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function finalLine(style: Style, run: Run, ref: string): string {
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
  let attemptN = lastAttempt(run)?.n ?? 0;
  // Only the tail is ever compared, so keep it bounded.
  let shown = lines(opts.shown);
  const print = (text: string) => ctx.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

  const poll = () => {
    const n = lastAttempt(run)?.n ?? 0;
    if (n !== attemptN) {
      attemptN = n;
      shown = [];
      if (!opts.raw) print(`\n--- attempt ${n} ---`);
    }
    const text = currentOutput(ctx, run);
    if (text === null) return;
    const next = lines(text);
    const fresh = newLines(shown, next);
    if (fresh.length > 0) print(fresh.join("\n"));
    shown = [...shown, ...fresh].slice(-Math.max(next.length, 1000));
  };

  while (isInProgress(run.status)) {
    if (opts.signal?.aborted) return { run, finished: false };
    await opts.sleep(interval);
    if (opts.signal?.aborted) return { run, finished: false };
    run = readRunRef(ctx, ref);
    poll();
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
