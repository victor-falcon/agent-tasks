import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { capturedLog, renderAttempt, renderEvents } from "../commands/log.ts";
import type { Context } from "../context.ts";
import { slotLabel } from "../output/runs-table.ts";
import type { Style } from "../output/style.ts";
import { statusLabel } from "../output/symbols.ts";
import { formatSpan } from "../output/time.ts";
import { tildify } from "../paths.ts";
import { attemptDuration, isInProgress, neverStarted } from "../run-info.ts";
import type { Run } from "../schema.ts";
import { runRef, runSlotId } from "../slot.ts";
import { readRunByRef, readTask } from "../store.ts";
import { describeSchedule, displayTimezone } from "../task-info.ts";
import { sanitize, wrap } from "./text.ts";

// The detail view of one run: what it did (summary, the --output-file), how
// (attempts, events) and the log captured from its session, as lines ready
// to scroll. Sections are where `{` and `}` jump to.

export interface Section {
  name: string;
  line: number;
}

export interface RunDetail {
  ref: string;
  run: Run;
  /** `■ ok · 6m`: the title line's right side. */
  status: string;
  lines: string[];
  sections: Section[];
}

/** At most this much of a file is shown; the rest is one line saying where it is. */
const MAX_FILE_BYTES = 512 * 1024;

function readShown(path: string): { text: string; cut: boolean } | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path);
  const cut = content.length > MAX_FILE_BYTES;
  // Keep the end: that's where the result usually is.
  return { text: (cut ? content.subarray(content.length - MAX_FILE_BYTES) : content).toString("utf8"), cut };
}

function heading(style: Style, name: string, extra: string, width: number): string {
  const head = `── ${name}${extra ? ` · ${extra}` : ""} `;
  return style.paint("bold", head + "─".repeat(Math.max(0, width - head.length)));
}

export function buildRunDetail(ctx: Context, style: Style, ref: string, width: number): RunDetail {
  const run = readRunByRef(ctx.paths, ref);
  const tz = displayTimezone(ctx);
  const lines: string[] = [];
  const sections: Section[] = [];
  const section = (name: string, extra = "") => {
    if (lines.length > 0) lines.push("");
    sections.push({ name, line: lines.length });
    lines.push(heading(style, name, extra, width));
  };
  const text = (content: string) => lines.push(...wrap(sanitize(content).trimEnd(), width));

  // Overview
  section("Run");
  let task = null;
  try {
    task = readTask(ctx.paths, run.task_id);
  } catch {
    // A removed task: its runs are still worth reading.
  }
  const last = run.attempts.at(-1);
  const rows: [string, string][] = [
    ["Task", task ? `${task.id} — ${task.title}` : `${run.task_id} (removed)`],
    ...(task ? ([["Folder", tildify(task.cwd, ctx.env)], ["Schedule", describeSchedule(task)]] as [string, string][]) : []),
    ["Slot", slotLabel(run, tz, ctx.now)],
    ["Status", `${statusLabel(style, run.status)}${run.reason ? ` (${run.reason})` : ""}`],
    ...(last ? ([["Attempts", `${run.attempts.length}${task ? ` of ${(task.retries ?? 0) + 1}` : ""}`]] as [string, string][]) : []),
  ];
  for (const [label, value] of rows) lines.push(`${style.paint("dim", label.padEnd(9))} ${value}`);
  const summary = last?.summary;
  if (summary) {
    lines.push(style.paint("dim", "Summary"));
    for (const l of wrap(sanitize(summary), Math.max(10, width - 2))) lines.push(`  ${l}`);
  } else if (neverStarted(run.status)) lines.push(style.paint("dim", "It never started, so there is no output or log."));

  // The file passed to `finish --output-file`
  if (last?.output) {
    const path = isAbsolute(last.output) ? last.output : join(ctx.paths.dataDir, last.output);
    section("Output", tildify(path, ctx.env));
    const shown = readShown(path);
    if (!shown) lines.push(style.paint("dim", "(the file is gone)"));
    else {
      if (shown.cut) lines.push(style.paint("dim", `(only the last ${MAX_FILE_BYTES / 1024} KiB)`));
      text(shown.text);
    }
  }

  if (run.attempts.length > 0) {
    section("Attempts");
    run.attempts.forEach((attempt, i) => {
      if (i > 0) lines.push("");
      lines.push(...renderAttempt(ctx, style, run, attempt, null, tz).split("\n"));
    });
  }

  section("Events");
  lines.push(...renderEvents(run, tz, ctx.now).split("\n").slice(1));

  // The output captured from the latest attempt's session
  const log = capturedLog(ctx, run, last);
  if (log) {
    section("Log", tildify(log.path, ctx.env));
    const shown = log.exists ? readShown(log.path) : null;
    if (!shown) lines.push(style.paint("dim", isInProgress(run.status) ? "(not captured yet: it is still in progress)" : "(nothing captured)"));
    else if (shown.text.trim() === "") lines.push(style.paint("dim", "(empty)"));
    else {
      if (shown.cut) lines.push(style.paint("dim", `(only the last ${MAX_FILE_BYTES / 1024} KiB)`));
      text(shown.text);
    }
  }

  const took = attemptDuration(run, ctx.now);
  const status = `${statusLabel(style, run.status)}${took !== null ? ` · ${formatSpan(took)}${isInProgress(run.status) ? " so far" : ""}` : ""}`;
  return { ref: runRef(run.task_id, runSlotId(run)), run, status, lines, sections };
}
