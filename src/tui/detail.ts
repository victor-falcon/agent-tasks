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
import { fit, sanitize, wrap } from "./text.ts";

// The detail view of one run. What people open a run for is its result, so
// that comes first and open (the summary, the --output-file); the rest
// (details, attempts, events, the captured log) are folded sections that
// <CR> opens. A run with no result yet (in progress, or it failed without a
// summary) opens its log instead.

export interface Section {
  id: "result" | "output" | "details" | "attempts" | "events" | "log";
  name: string;
  /** Shown after the name: what is inside when it is folded (`6 events · last 13:12`). */
  extra: string;
  lines: string[];
  /** Open unless the user folds it. */
  open: boolean;
}

export interface RunDetail {
  ref: string;
  run: Run;
  /** `■ ok · 6m`: the title line's right side. */
  status: string;
  sections: Section[];
  width: number;
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function buildRunDetail(ctx: Context, style: Style, ref: string, width: number): RunDetail {
  const run = readRunByRef(ctx.paths, ref);
  const tz = displayTimezone(ctx);
  const sections: Section[] = [];
  const text = (content: string) => wrap(sanitize(content).trimEnd(), width);
  const fileLines = (path: string): string[] => {
    const shown = readShown(path);
    if (!shown) return [];
    return [...(shown.cut ? [style.paint("dim", `(only the last ${MAX_FILE_BYTES / 1024} KiB)`)] : []), ...text(shown.text)];
  };

  let task = null;
  try {
    task = readTask(ctx.paths, run.task_id);
  } catch {
    // A removed task: its runs are still worth reading.
  }
  const last = run.attempts.at(-1);
  const took = attemptDuration(run, ctx.now);
  const inProgress = isInProgress(run.status);
  const log = capturedLog(ctx, run, last);

  // The result: how it ended and what the agent said.
  const result: string[] = [];
  const facts = [
    `${statusLabel(style, run.status)}${run.reason ? ` (${run.reason})` : ""}`,
    slotLabel(run, tz, ctx.now),
    ...(took !== null ? [`${inProgress ? "running for" : "took"} ${formatSpan(took)}`] : []),
    // A manual retry can go past the task's retries: no "of N" here (Details has it).
    ...(run.attempts.length > 1 ? [`attempt ${run.attempts.length}`] : []),
  ];
  result.push(facts.join(style.paint("dim", " · ")), "");
  const summary = last?.summary;
  const hasResult = Boolean(summary || last?.output);
  const note = (content: string) => result.push(...wrap(content, width).map((l) => style.paint("dim", l)));
  if (summary) result.push(...text(summary));
  else if (neverStarted(run.status)) note("It never started, so there is no output or log.");
  else {
    const below = log ? " Its log is below." : "";
    note(inProgress ? `Still in progress: the agent reports its result when it finishes.${below}` : `The agent reported no summary.${below}`);
  }
  sections.push({ id: "result", name: "Result", extra: "", lines: result, open: true });

  // The file passed to `finish --output-file`: part of the result.
  if (last?.output) {
    const path = isAbsolute(last.output) ? last.output : join(ctx.paths.dataDir, last.output);
    const lines = fileLines(path);
    sections.push({ id: "output", name: "Output", extra: tildify(path, ctx.env), lines: lines.length > 0 ? lines : [style.paint("dim", "(the file is gone)")], open: true });
  }

  // The task and the run, for when the result raises questions.
  const rows: [string, string][] = [
    ["Task", task ? `${task.id} — ${task.title}` : `${run.task_id} (removed)`],
    ...(task ? ([["Folder", tildify(task.cwd, ctx.env)], ["Schedule", describeSchedule(task)]] as [string, string][]) : []),
    ["Slot", slotLabel(run, tz, ctx.now)],
    ...(last ? ([["Attempts", `${run.attempts.length}${task ? ` of ${(task.retries ?? 0) + 1}` : ""}`]] as [string, string][]) : []),
    ["Run ref", runRef(run.task_id, runSlotId(run))],
  ];
  sections.push({
    id: "details",
    name: "Details",
    extra: task ? `${task.title} · ${tildify(task.cwd, ctx.env)}` : `${run.task_id} (removed)`,
    lines: rows.map(([label, value]) => `${style.paint("dim", label.padEnd(9))} ${value}`),
    open: false,
  });

  if (run.attempts.length > 0) {
    const lines: string[] = [];
    run.attempts.forEach((attempt, i) => {
      if (i > 0) lines.push("");
      lines.push(...renderAttempt(ctx, style, run, attempt, null, tz).split("\n"));
    });
    sections.push({ id: "attempts", name: "Attempts", extra: plural(run.attempts.length, "attempt"), lines, open: false });
  }

  const events = renderEvents(run, tz, ctx.now).split("\n").slice(1);
  const lastEvent = run.events.at(-1);
  sections.push({ id: "events", name: "Events", extra: lastEvent ? `${plural(run.events.length, "event")} · last: ${lastEvent.event}` : "none", lines: events, open: false });

  // The output captured from the latest attempt's session
  if (log) {
    const shown = log.exists ? readShown(log.path) : null;
    const content = shown ? sanitize(shown.text).trimEnd() : "";
    let lines: string[];
    let extra = tildify(log.path, ctx.env);
    if (!shown) lines = [style.paint("dim", inProgress ? "(not captured yet: it is still in progress)" : "(nothing captured)")];
    else if (content.trim() === "") lines = [style.paint("dim", "(empty)")];
    else {
      lines = [...(shown.cut ? [style.paint("dim", `(only the last ${MAX_FILE_BYTES / 1024} KiB)`)] : []), ...wrap(content, width)];
      extra = `${plural(content.split("\n").length, "line")} · ${extra}`;
    }
    // Without a result to read, the log is the next best thing.
    sections.push({ id: "log", name: "Log", extra, lines, open: !hasResult && !neverStarted(run.status) });
  }

  const status = `${statusLabel(style, run.status)}${took !== null ? ` · ${formatSpan(took)}${inProgress ? " so far" : ""}` : ""}`;
  return { ref: runRef(run.task_id, runSlotId(run)), run, status, sections, width };
}

// ---------------------------------------------------------------------------
// Folding: the sections as lines on the screen
// ---------------------------------------------------------------------------

export interface DetailView {
  detail: RunDetail;
  scroll: number;
  /** The section `<CR>` folds or opens; `{` and `}` move it. */
  selected: number;
  /** Sections the user opened or folded, by id: kept when the run is read again. */
  folds: Partial<Record<Section["id"], boolean>>;
}

export function isOpen(view: DetailView, section: Section): boolean {
  return view.folds[section.id] ?? section.open;
}

function heading(style: Style, section: Section, open: boolean, selected: boolean, width: number): string {
  const head = `${open ? "▾" : "▸"} ${section.name}${section.extra ? ` · ${section.extra}` : ""} `;
  const rule = fit(head + "─".repeat(Math.max(0, width - Bun.stringWidth(head))), width).trimEnd();
  // The selected one stands out like the selected row of a panel.
  return selected ? style.paint("inverse", fit(rule, width)) : open ? style.paint("bold", rule) : rule;
}

/** The lines to scroll through, and the line each section's heading is on. */
export function layoutDetail(view: DetailView, style: Style): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  const { sections, width } = view.detail;
  sections.forEach((section, i) => {
    const open = isOpen(view, section);
    // A blank line before an open section, and after one, sets it apart; folded ones stack.
    const previousOpen = i > 0 && isOpen(view, sections[i - 1]!);
    if (i > 0 && (open || previousOpen)) lines.push("");
    starts.push(lines.length);
    lines.push(heading(style, section, open, i === view.selected, width));
    if (open) lines.push(...section.lines);
  });
  return { lines, starts };
}
