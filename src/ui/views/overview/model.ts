import type { Context } from "../../../context.ts";
import type { Color } from "../../../output/style.ts";
import { PENDING_MARK, RUN_MARKS, TASK_MARKS } from "../../../output/symbols.ts";
import { agendaTime, clockTime, DAY, formatSpan, relativeTime } from "../../../output/time.ts";
import type { RunStatus } from "../../../schema.ts";
import { readTask } from "../../../store.ts";
import { taskOverview } from "../../../task-info.ts";
import type { Dashboard, DashNext, DashRun } from "../../../tui/snapshot.ts";
import type { Target } from "../../actions.ts";
import { buildRunPreview, type RunPreviewData } from "../../components/run-preview-model.ts";
import { ATTENTION_WINDOW_MS, SEEABLE, type Seen } from "../../seen.ts";

// What the Overview shows, as plain data (cells with a color name), so it is
// tested without a renderer: the sections of the list, the target of a
// selected row, and the preview of the selection.

export interface Cell {
  text: string;
  color?: Color;
}

export interface Row {
  /** Identity of the row: `<section>:<run ref or task id>`. Selection follows it across reloads. */
  key: string;
  cells: Cell[];
}

export type SectionId = "attention" | "running" | "next" | "recent";

export interface Section {
  id: SectionId;
  title: string;
  rows: Row[];
  /** Shown instead of rows when there are none; null hides the section (Needs attention). */
  empty: string | null;
}

export interface OverviewInput {
  dash: Dashboard;
  now: Date;
  timezone: string;
  seen: Seen;
}

export function attentionRuns({ dash, now, seen }: OverviewInput): DashRun[] {
  const since = now.getTime() - ATTENTION_WINDOW_MS;
  const blocked = dash.running.filter((r) => r.status === "blocked");
  const failures = dash.recent.filter((r) => SEEABLE.includes(r.status) && Date.parse(r.at) >= since && !seen.isSeen(r.ref, r.at));
  return [...blocked, ...failures];
}

const key = (section: SectionId, id: string) => `${section}:${id}`;

/** A row key: `recent:<ref>` → `{ section: "recent", id: "<ref>" }`. */
export function parseKey(rowKey: string): { section: SectionId; id: string } {
  const cut = rowKey.indexOf(":");
  return { section: rowKey.slice(0, cut) as SectionId, id: rowKey.slice(cut + 1) };
}

function runCells(r: DashRun, input: OverviewInput): Cell[] {
  const mark = RUN_MARKS[r.status];
  const { timezone, now } = input;
  if (r.status === "running" || r.status === "blocked") {
    const since = r.started_at ? new Date(r.started_at) : null;
    return [
      { text: mark.symbol, color: mark.color },
      { text: r.task_id },
      { text: r.status, color: mark.color },
      { text: since ? `since ${clockTime(since, timezone)}` : "" },
      { text: since ? formatSpan(now.getTime() - since.getTime()) : "" },
      { text: r.attempt > 1 ? `attempt ${r.attempt}` : "" },
      { text: r.machine ?? "", color: "dim" },
    ];
  }
  const took = r.started_at && r.finished_at ? formatSpan(Date.parse(r.finished_at) - Date.parse(r.started_at)) : "–";
  const what = r.summary ? { text: r.summary.split("\n")[0]! } : { text: r.reason?.split("\n")[0] ?? "", color: "dim" as const };
  return [{ text: mark.symbol, color: mark.color }, { text: agendaTime(new Date(r.at), timezone, now) }, { text: r.task_id }, { text: took }, { text: r.attempt > 1 ? `×${r.attempt}` : "" }, what];
}

function nextCells(n: DashNext, { timezone, now }: OverviewInput): Cell[] {
  if (n.at === null) {
    return [{ text: TASK_MARKS.paused.symbol, color: TASK_MARKS.paused.color }, { text: "paused", color: "dim" }, { text: n.task_id, color: "dim" }, { text: "" }, { text: n.schedule, color: "dim" }];
  }
  const at = new Date(n.at);
  return [{ text: "○", color: PENDING_MARK.color }, { text: agendaTime(at, timezone, now) }, { text: n.task_id }, { text: relativeTime(at, now) }, { text: n.schedule, color: "dim" }];
}

export function overviewSections(input: OverviewInput): Section[] {
  const { dash } = input;
  return [
    { id: "attention", title: "Needs attention", rows: attentionRuns(input).map((r) => ({ key: key("attention", r.ref), cells: runCells(r, input) })), empty: null },
    // Blocked runs wait for you: they are in Needs attention, not here.
    { id: "running", title: "Running", rows: dash.running.filter((r) => r.status !== "blocked").map((r) => ({ key: key("running", r.ref), cells: runCells(r, input) })), empty: "nothing running" },
    { id: "next", title: "Next", rows: dash.next.map((n) => ({ key: key("next", n.task_id), cells: nextCells(n, input) })), empty: "nothing scheduled" },
    { id: "recent", title: "Recent", rows: dash.recent.map((r) => ({ key: key("recent", r.ref), cells: runCells(r, input) })), empty: "no runs yet" },
  ];
}

/** What a row acts on. */
export function targetOf(dash: Dashboard, rowKey: string | null): Target | null {
  if (!rowKey) return null;
  const { section, id } = parseKey(rowKey);
  if (section === "next") {
    const next = dash.next.find((n) => n.task_id === id);
    return next ? { kind: "task", taskId: id } : null;
  }
  const run = [...dash.running, ...dash.recent].find((r) => r.ref === id);
  return run ? { kind: "run", run } : null;
}

// ---------------------------------------------------------------------------
// The preview of the selection
// ---------------------------------------------------------------------------

/** Next slots and past results shown for a task. */
export const PREVIEW_SLOTS = 5;
export const PREVIEW_STRIP = 10;

export type Preview =
  | { kind: "none" }
  | ({ kind: "run" } & RunPreviewData)
  | { kind: "task"; next: DashNext; title: string; description: string | null; slots: string[]; strip: RunStatus[] };

export function buildPreview(ctx: Context, dash: Dashboard, rowKey: string | null): Preview {
  const target = targetOf(dash, rowKey);
  if (!target) return { kind: "none" };
  if (target.kind === "run") return { kind: "run", ...buildRunPreview(ctx, target.run) };
  const next = dash.next.find((n) => n.task_id === target.taskId)!;
  try {
    const task = readTask(ctx.paths, target.taskId);
    const overview = taskOverview(ctx, task, { nextCount: PREVIEW_SLOTS });
    const strip = overview.runs
      .map((r) => r.run)
      .filter((r) => r.status !== "superseded" && r.status !== "cancelled")
      .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot))
      .slice(-PREVIEW_STRIP)
      .map((r) => r.status);
    return { kind: "task", next, title: task.title, description: task.description ?? null, slots: overview.next, strip };
  } catch {
    return { kind: "task", next, title: next.title, description: null, slots: next.at ? [next.at] : [], strip: [] };
  }
}
