import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { capturedLog, renderAttempt, renderEvents } from "../../../commands/log.ts";
import type { Context } from "../../../context.ts";
import { slotLabel } from "../../../output/runs-table.ts";
import { createStyle } from "../../../output/style.ts";
import { RUN_MARKS } from "../../../output/symbols.ts";
import { formatSpan } from "../../../output/time.ts";
import { tildify } from "../../../paths.ts";
import { attemptDuration, isInProgress, lastActivity, neverStarted } from "../../../run-info.ts";
import type { Run, SessionRecord, Task } from "../../../schema.ts";
import { runRef, runSlotId } from "../../../slot.ts";
import { readRunByRef, readTask } from "../../../store.ts";
import { describeSchedule } from "../../../task-info.ts";
import type { DashRun } from "../../../tui/snapshot.ts";
import { sanitize } from "../../../tui/text.ts";
import type { Segment } from "../../components/cells.ts";

// What the Run detail shows, as plain data: the same sections as the old
// dashboard's run view (src/tui/detail.ts, whose pieces it reuses: the
// attempt and event renderers of `agent-tasks log`, the captured log, the
// slot label), but as blocks a component renders (Markdown, code, lines of
// colored cells) instead of ANSI strings cut to a width. Also the pure part
// of moving through it: which section j/k select and where the view scrolls.

export type SectionId = "result" | "output" | "details" | "attempts" | "events" | "log";

export type Block =
  /** How the run ended: drawn from the run and the clock, so "running for" ticks. */
  | { kind: "facts" }
  | { kind: "lines"; lines: Segment[][] }
  | { kind: "markdown"; text: string }
  /** `filetype` when OpenTUI has a parser for it; plain text otherwise. */
  | { kind: "code"; text: string; filetype?: string }
  /** The captured log, sanitized; the view wraps it to its width (one row per line, for search). */
  | { kind: "log"; text: string };

export interface RunSection {
  id: SectionId;
  name: string;
  /** After the name: what is inside when it is folded (`6 events · last: finished`). */
  extra: string;
  blocks: Block[];
  /** Open unless the user folds it. */
  open: boolean;
}

export interface RunModel {
  ref: string;
  run: Run;
  /** The run as the shared actions take it (attach, retry, run now). */
  target: DashRun;
  /** The latest attempt's summary (what `Y` copies). */
  summary: string | null;
  /** The `--output-file` of the latest attempt, absolute (what `o` opens), or null. */
  outputPath: string | null;
  blocked: boolean;
  sections: RunSection[];
}

/** At most this much of a file is shown; the rest is one line saying so. */
export const MAX_FILE_BYTES = 512 * 1024;

const PLAIN = createStyle(false);

/** The file, or only its end when it is big (that's where the result usually is): read again on every reload of a running log. */
export function readShown(path: string, max = MAX_FILE_BYTES): { text: string; cut: boolean } | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // A cut can split a character or a line: start at the next whole line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return { text, cut: length < size };
  } finally {
    closeSync(fd);
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const dim = (text: string): Segment[] => [{ text, color: "dim" }];
const cutNote = (): Block => ({ kind: "lines", lines: [dim(`(only the last ${MAX_FILE_BYTES / 1024} KiB)`)] });

/** Parsers OpenTUI bundles, by extension; anything else is shown as plain text. */
const FILETYPES: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".zig": "zig",
};

const MARKDOWN = [".md", ".markdown"];

/** `■ ok`, `✕ failed`… as a colored cell. */
export function statusCell(status: Run["status"]): Segment {
  const mark = RUN_MARKS[status];
  return { text: `${mark.symbol} ${status === "succeeded" ? "ok" : status}`, color: mark.color };
}

/** The view's title: ref, status and how long it took (or has been going). */
export function runTitle(run: Run, ref: string, now: Date): Segment[] {
  const took = attemptDuration(run, now);
  return [
    { text: ref, color: "bold" },
    { text: "  " },
    statusCell(run.status),
    ...(took !== null ? [{ text: ` · ${formatSpan(took)}${isInProgress(run.status) ? " so far" : ""}`, color: "dim" as const }] : []),
  ];
}

/** The first line of Result: status (and reason), slot, duration, attempt. */
export function resultFacts(run: Run, timezone: string, now: Date): Segment[] {
  const took = attemptDuration(run, now);
  const facts: Segment[][] = [
    [statusCell(run.status), ...(run.reason ? [{ text: ` (${run.reason})` }] : [])],
    [{ text: slotLabel(run, timezone, now) }],
    ...(took !== null ? [[{ text: `${isInProgress(run.status) ? "running for" : "took"} ${formatSpan(took)}` }]] : []),
    // A manual retry can go past the task's retries: no "of N" here (Details has it).
    ...(run.attempts.length > 1 ? [[{ text: `attempt ${run.attempts.length}` }]] : []),
  ];
  return facts.flatMap((fact, i) => (i === 0 ? fact : [{ text: " · ", color: "dim" as const }, ...fact]));
}

/**
 * The run as the shared actions see it (the dashboard's row shape), for runs
 * outside the snapshot too (older than its last 100). Mirrors snapshot.ts's
 * dashRun, which is not exported and src/tui stays untouched until T7.
 */
function dashRunOf(ref: string, run: Run): DashRun {
  const last = run.attempts.at(-1);
  return {
    ref,
    task_id: run.task_id,
    status: run.status,
    slot: run.slot,
    attempt: last?.n ?? 0,
    started_at: last?.started_at ?? null,
    finished_at: last?.finished_at ?? null,
    at: lastActivity(run),
    summary: last?.summary ?? null,
    reason: last?.reason ?? run.reason ?? null,
    handle: last?.session?.handle ?? null,
    machine: last?.session?.machine ?? null,
  };
}

/** Reads the run `ref` (throws when it is gone) and lays out its sections. */
export function buildRunModel(ctx: Context, ref: string, timezone: string): RunModel {
  const run = readRunByRef(ctx.paths, ref);
  const canonical = runRef(run.task_id, runSlotId(run));
  let task: Task | null = null;
  try {
    task = readTask(ctx.paths, run.task_id);
  } catch {
    // A removed task: its runs are still worth reading.
  }
  const last = run.attempts.at(-1);
  const inProgress = isInProgress(run.status);
  const log = capturedLog(ctx, run, last);
  const sections: RunSection[] = [];

  // The result: how it ended and what the agent said.
  // Written by the agent: no escape sequences or control characters reach the screen or the clipboard.
  const summary = last?.summary ? sanitize(last.summary).trimEnd() : null;
  const result: Block[] = [{ kind: "facts" }];
  if (summary) result.push({ kind: "markdown", text: summary });
  else {
    const below = log ? " Its log is below." : "";
    const note = neverStarted(run.status)
      ? "It never started, so there is no output or log."
      : inProgress
        ? `Still in progress: the agent reports its result when it finishes.${below}`
        : `The agent reported no summary.${below}`;
    result.push({ kind: "lines", lines: [dim(note)] });
  }
  sections.push({ id: "result", name: "Result", extra: "", blocks: result, open: true });

  // The file passed to `finish --output-file`: part of the result.
  let outputPath: string | null = null;
  if (last?.output) {
    outputPath = isAbsolute(last.output) ? last.output : join(ctx.paths.dataDir, last.output);
    const shown = readShown(outputPath);
    const blocks: Block[] = [];
    if (!shown) blocks.push({ kind: "lines", lines: [dim("(the file is gone)")] });
    else {
      if (shown.cut) blocks.push(cutNote());
      const text = sanitize(shown.text).trimEnd();
      const ext = extname(outputPath).toLowerCase();
      blocks.push(MARKDOWN.includes(ext) ? { kind: "markdown", text } : { kind: "code", text, filetype: FILETYPES[ext] });
    }
    sections.push({ id: "output", name: "Output", extra: tildify(outputPath, ctx.env), blocks, open: true });
  }

  // The task and the run, for when the result raises questions.
  const rows: [string, string][] = [["Task", task ? `${task.id} — ${task.title}` : `${run.task_id} (removed)`]];
  if (task) rows.push(["Folder", tildify(task.cwd, ctx.env)], ["Schedule", describeSchedule(task)]);
  rows.push(["Slot", slotLabel(run, timezone, ctx.now)]);
  if (last) rows.push(["Attempts", `${run.attempts.length}${task ? ` of ${(task.retries ?? 0) + 1}` : ""}`]);
  if (last?.session) rows.push(["Session", sessionState(last.session)]);
  rows.push(["Run ref", canonical]);
  sections.push({
    id: "details",
    name: "Details",
    extra: task ? `${task.title} · ${tildify(task.cwd, ctx.env)}` : `${run.task_id} (removed)`,
    blocks: [{ kind: "lines", lines: rows.map(([label, value]) => [{ text: label.padEnd(9), color: "dim" }, { text: ` ${value}` }]) }],
    open: false,
  });

  if (run.attempts.length > 0) {
    const lines: Segment[][] = [];
    run.attempts.forEach((attempt, i) => {
      if (i > 0) lines.push([]);
      const [head, ...rest] = renderAttempt(ctx, PLAIN, run, attempt, null, timezone).split("\n");
      lines.push([{ text: head!, color: "bold" }], ...rest.map((l) => [{ text: l }]));
    });
    sections.push({ id: "attempts", name: "Attempts", extra: plural(run.attempts.length, "attempt"), blocks: [{ kind: "lines", lines }], open: false });
  }

  const events = renderEvents(run, timezone, ctx.now).split("\n").slice(1);
  const lastEvent = run.events.at(-1);
  sections.push({
    id: "events",
    name: "Events",
    extra: lastEvent ? `${plural(run.events.length, "event")} · last: ${lastEvent.event}` : "none",
    blocks: [{ kind: "lines", lines: events.length > 0 ? events.map((l) => [{ text: l }]) : [dim("(none)")] }],
    open: false,
  });

  // The output captured from the latest attempt's session.
  const hasResult = Boolean(summary || last?.output);
  if (log) {
    const shown = log.exists ? readShown(log.path) : null;
    const content = shown ? sanitize(shown.text).trimEnd() : "";
    let extra = tildify(log.path, ctx.env);
    const blocks: Block[] = [];
    if (!shown) blocks.push({ kind: "lines", lines: [dim(inProgress ? "(not captured yet: it is still in progress)" : "(nothing captured)")] });
    else if (content.trim() === "") blocks.push({ kind: "lines", lines: [dim("(empty)")] });
    else {
      if (shown.cut) blocks.push(cutNote());
      blocks.push({ kind: "log", text: content });
      extra = `${plural(content.split("\n").length, "line")} · ${extra}`;
    }
    // Without a result to read, the log is the next best thing.
    sections.push({ id: "log", name: "Log", extra, blocks, open: !hasResult && !neverStarted(run.status) });
  }

  return { ref: canonical, run, target: dashRunOf(canonical, run), summary, outputPath, blocked: run.status === "blocked", sections };
}

function sessionState(session: SessionRecord): string {
  const where = `${session.launcher} ${session.handle}${session.machine ? ` on ${session.machine}` : ""}`;
  if (session.closed_at) return `${where} (closed)`;
  return `${where} (open${session.kept_open ? ", kept open" : ""})`;
}

/** The session of the run's latest attempt while it is open (what `c` closes), or null. */
export function openSession(run: Run): SessionRecord | null {
  const session = run.attempts.at(-1)?.session;
  return session && !session.closed_at ? session : null;
}

// ---------------------------------------------------------------------------
// The log, wrapped, and searching it
// ---------------------------------------------------------------------------

/** Smart case, like Vim's: a query with a capital letter matches case, else it does not. */
export function matchRows(rows: readonly string[], query: string): number[] {
  if (query === "") return [];
  const exact = query !== query.toLowerCase();
  const needle = exact ? query : query.toLowerCase();
  const out: number[] = [];
  rows.forEach((row, i) => {
    if ((exact ? row : row.toLowerCase()).includes(needle)) out.push(i);
  });
  return out;
}

/** The match to go to from `from` (a row, or -1 before the first), forward or backward, wrapping around. */
export function nextMatch(matches: readonly number[], from: number, direction: 1 | -1): number | null {
  if (matches.length === 0) return null;
  if (direction > 0) return matches.find((m) => m > from) ?? matches[0]!;
  return [...matches].reverse().find((m) => m < from) ?? matches.at(-1)!;
}

// ---------------------------------------------------------------------------
// Moving: j/k between sections, scrolling through a long open one
// ---------------------------------------------------------------------------

/** Where the sections are, in rows of the scrolled content. */
export interface Geometry {
  /** The row of each section's heading. */
  starts: readonly number[];
  /** The last row of each section (its heading when folded). */
  ends: readonly number[];
  /** Rows shown at once. */
  viewport: number;
  /** Rows of the whole content. */
  total: number;
}

export interface Place {
  selected: number;
  scroll: number;
}

const maxScroll = (g: Geometry) => Math.max(0, g.total - g.viewport);
const clampScroll = (g: Geometry, scroll: number) => Math.max(0, Math.min(maxScroll(g), scroll));

/**
 * Scrolls as little as possible to show the selected section: its heading
 * and as much of it as fits below, or (`fromBelow`, moving up into a long
 * section) its end, to read it upwards.
 */
export function reveal(g: Geometry, place: Place, fromBelow = false): number {
  const head = g.starts[place.selected] ?? 0;
  const end = g.ends[place.selected] ?? head;
  let scroll = place.scroll;
  if (fromBelow) {
    if (head < scroll) scroll = Math.max(head, Math.min(scroll, end - g.viewport + 1));
  } else {
    if (end >= scroll + g.viewport) scroll = end - g.viewport + 1;
    if (head < scroll) scroll = head;
  }
  return clampScroll(g, scroll);
}

/** The section the top row of the view is in. */
export function sectionAt(g: Geometry, row: number): number {
  return Math.max(0, g.starts.filter((start) => start <= row).length - 1);
}

/**
 * j/k (`by` ±1) move between sections like rows of a list; inside an open
 * section longer than the view they scroll it a row at a time until the
 * next (or previous) heading comes into view. Bigger steps (half pages)
 * scroll and select the section being read; ±Infinity go to the first or
 * last section. A selection the wheel scrolled out of view is first moved
 * to the section being read.
 */
export function moveInRun(g: Geometry, place: Place, by: number): Place {
  const last = g.starts.length - 1;
  if (last < 0) return place;
  if (by === Number.NEGATIVE_INFINITY) return { selected: 0, scroll: 0 };
  if (by === Number.POSITIVE_INFINITY) return { selected: last, scroll: maxScroll(g) };
  const onScreen = (row: number) => row >= place.scroll && row < place.scroll + g.viewport;
  let { selected } = place;
  const shown = (i: number) => (g.ends[i] ?? 0) >= place.scroll && (g.starts[i] ?? 0) < place.scroll + g.viewport;
  if (!shown(selected)) selected = sectionAt(g, place.scroll);
  if (Math.abs(by) === 1) {
    if (by > 0) {
      const next = g.starts[selected + 1];
      if (next !== undefined && onScreen(next)) return { selected: selected + 1, scroll: reveal(g, { selected: selected + 1, scroll: place.scroll }) };
      return { selected, scroll: clampScroll(g, place.scroll + 1) };
    }
    const here = g.starts[selected]!;
    if (selected > 0 && here >= place.scroll) return { selected: selected - 1, scroll: reveal(g, { selected: selected - 1, scroll: place.scroll }, true) };
    return { selected, scroll: clampScroll(g, place.scroll - 1) };
  }
  const scroll = clampScroll(g, place.scroll + by);
  return { selected: maxScroll(g) > 0 ? sectionAt(g, scroll) : selected, scroll };
}

/**
 * The log as a few segments of one text: the rows between matches joined,
 * each matching row on its own (yellow) and the current match inverse, so a
 * long log is one text and not a renderable per row.
 */
export function logSegments(rows: readonly string[], matches: readonly number[], current: number | null): Segment[] {
  const marked = new Set(matches);
  const out: Segment[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length > 0) out.push({ text: plain.join("\n") });
    plain = [];
  };
  rows.forEach((row, i) => {
    const end = i < rows.length - 1 ? "\n" : "";
    if (!marked.has(i)) {
      plain.push(row);
      return;
    }
    // The newline before a match belongs to the plain run before it.
    if (plain.length > 0) {
      out.push({ text: `${plain.join("\n")}\n` });
      plain = [];
    }
    out.push({ text: row, color: i === current ? "inverse" : "yellow" });
    if (end) out.push({ text: end });
  });
  flush();
  return out;
}
