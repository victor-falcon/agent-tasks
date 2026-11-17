import { agentCommand, eventTime, pairs } from "../output/run-log.ts";
import type { Style } from "../output/style.ts";
import { paintMark, RUN_MARKS, TASK_MARKS } from "../output/symbols.ts";
import { absoluteTime, agendaTime, formatSpan, MINUTE, relativeTime, timeNear, whenTime } from "../output/time.ts";
import { attemptDuration, isFailure, runSummary } from "../run-info.ts";
import type { StatusInfo } from "../runner-render.ts";
import type { RunStatus } from "../schema.ts";
import { historyStrip } from "../task-row.ts";
import { fit, hardWrap, spread, width, wrap } from "./ansi.ts";
import type { RecentItem, TaskItem, TuiData, UpcomingItem } from "./data.ts";
import { type Bounds, type Model, matches, PANEL_TITLES, PANELS, type Panel, type RowRef } from "./model.ts";

// Model + data + terminal size → the lines of the screen. Pure: the same
// input always draws the same screen, so it is tested with snapshots.

export interface Size {
  width: number;
  height: number;
}

/** What the runner knows about itself, for the header. */
export interface RunnerInfo {
  every: string;
  status: StatusInfo;
}

/** The output shown by the log view, kept by the IO layer. */
export interface LogContent {
  lines: readonly string[];
  /** Still polling the run for new output. */
  following: boolean;
}

export interface ViewInput {
  model: Model;
  data: TuiData;
  runner: RunnerInfo;
  log: LogContent | null;
  size: Size;
  now: Date;
  style: Style;
}

/** Below this width the Detail panel is not shown next to the lists (`l` shows it instead of them). */
export const WIDE_MIN = 96;
export const MIN_WIDTH = 40;
export const MIN_HEIGHT = 8;
/** Below this many list rows, only the selected panel is shown. */
const STACK_MIN_ROWS = 9;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

interface Layout {
  tooSmall: boolean;
  body: number;
  leftWidth: number;
  rightWidth: number;
  showList: boolean;
  showDetail: boolean;
  /** Left column sections and their visible rows. */
  sections: { panel: Panel; rows: number }[];
}

function sectionRows(available: number, counts: Record<Panel, number>): Record<Panel, number> {
  const want = { recent: Math.max(1, counts.recent), upcoming: Math.max(1, counts.upcoming), tasks: Math.max(1, counts.tasks) };
  const share = Math.floor(available / 3);
  const rows = { recent: Math.min(want.recent, share), upcoming: Math.min(want.upcoming, share), tasks: Math.min(want.tasks, share) };
  let left = available - rows.recent - rows.upcoming - rows.tasks;
  for (const panel of ["recent", "tasks", "upcoming"] as const) {
    const extra = Math.min(left, want[panel] - rows[panel]);
    rows[panel] += extra;
    left -= extra;
  }
  rows.recent += left; // empty space goes to the busiest panel
  return rows;
}

function layout({ model, data, size }: Pick<ViewInput, "model" | "data" | "size">): Layout {
  const body = size.height - 2;
  const tooSmall = size.width < MIN_WIDTH || size.height < MIN_HEIGHT;
  const wide = size.width >= WIDE_MIN;
  const leftWidth = wide ? Math.floor(size.width / 2) : size.width;
  const showDetail = wide || model.focus === "detail";
  const showList = wide || model.focus !== "detail";
  let sections: Layout["sections"] = [];
  if (showList && !tooSmall) {
    const available = body - 4; // top, two separators, bottom
    if (available < STACK_MIN_ROWS) sections = [{ panel: model.panel, rows: body - 2 }];
    else {
      const rows = sectionRows(available, { recent: data.recent.length, upcoming: data.upcoming.length, tasks: data.tasks.length });
      sections = PANELS.map((panel) => ({ panel, rows: rows[panel] }));
    }
  }
  return { tooSmall, body, leftWidth, rightWidth: wide ? size.width - leftWidth : size.width, showList, showDetail, sections };
}

/** The first visible row of a list so that the cursor is on screen. */
function listOffset(cursor: number, rows: number): number {
  return rows <= 0 || cursor < rows ? 0 : cursor - rows + 1;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function statusWord(status: RunStatus): string {
  return status === "succeeded" ? "ok" : status.replace("_", " ");
}

function statusText(style: Style, status: RunStatus): string {
  const mark = RUN_MARKS[status];
  return style.paint(mark.color, `${mark.symbol} ${statusWord(status)}`);
}

const pad = (text: string, cols: number) => text + " ".repeat(Math.max(0, cols - width(text)));

interface RowContext {
  style: Style;
  now: Date;
  tz: string;
  query: string | null;
}

function taskId(ctx: RowContext, id: string): string {
  return ctx.query && id.includes(ctx.query) ? ctx.style.paint("yellow", id) : id;
}

function recentRows(items: readonly RecentItem[], cols: number, ctx: RowContext): string[] {
  const times = items.map((i) => agendaTime(new Date(i.run.slot), ctx.tz, ctx.now));
  const timeWidth = Math.max(0, ...times.map(width));
  return items.map((item, i) => {
    const duration = attemptDuration(item.run, ctx.now);
    const left = `${pad(times[i]!, timeWidth)}  ${pad(statusText(ctx.style, item.run.status), 11)}  ${taskId(ctx, item.task_id)}`;
    return spread(left, ctx.style.paint("dim", duration === null ? "—" : formatSpan(duration)), cols);
  });
}

function upcomingRows(items: readonly UpcomingItem[], cols: number, ctx: RowContext): string[] {
  const times = items.map((i) => agendaTime(new Date(i.at), ctx.tz, ctx.now));
  const timeWidth = Math.max(0, ...times.map(width));
  return items.map((item, i) => {
    const left = `${pad(times[i]!, timeWidth)}  ${pad(relativeTime(new Date(item.at), ctx.now), 7)}  ${taskId(ctx, item.task_id)}`;
    return spread(left, ctx.style.paint("dim", item.schedule), cols);
  });
}

function taskNext(item: TaskItem, ctx: RowContext): string {
  const { row } = item;
  if (row.indicator === "running" || row.indicator === "blocked") return ctx.style.paint(row.indicator === "running" ? "cyan" : "magenta", row.indicator);
  if (row.state !== "active") return ctx.style.paint("dim", row.state === "finished" ? "done" : row.state);
  return ctx.style.paint("dim", row.next_run ? whenTime(new Date(row.next_run), ctx.tz, ctx.now) : "—");
}

function taskRows(items: readonly TaskItem[], cols: number, ctx: RowContext): string[] {
  const idWidth = Math.min(24, Math.max(0, ...items.map((i) => width(i.task.id))));
  return items.map((item) => {
    const id = width(item.task.id) > idWidth ? fit(item.task.id, idWidth) : pad(item.task.id, idWidth);
    const left = `${paintMark(ctx.style, TASK_MARKS[item.row.indicator])}  ${taskId(ctx, id)}  ${historyStrip(ctx.style, item.row)}`;
    return spread(left, taskNext(item, ctx), cols);
  });
}

const EMPTY: Record<Panel, string> = { recent: "no runs yet", upcoming: "nothing scheduled", tasks: "no tasks: agent-tasks add …" };

function panelRows(panel: Panel, data: TuiData, cols: number, ctx: RowContext): string[] {
  if (panel === "recent") return recentRows(data.recent, cols, ctx);
  if (panel === "upcoming") return upcomingRows(data.upcoming, cols, ctx);
  return taskRows(data.tasks, cols, ctx);
}

/** The keys' view of each list: stable keys, task ids and the run Enter opens. */
export function rowRefs(data: TuiData): Bounds["rows"] {
  const latest = new Map(data.tasks.map((t) => [t.task.id, t.recent[0]?.ref ?? null]));
  return {
    recent: data.recent.map((r): RowRef => ({ key: r.ref, task_id: r.task_id, ref: r.ref })),
    upcoming: data.upcoming.map((u): RowRef => ({ key: `${u.task_id}@${u.at}`, task_id: u.task_id, ref: latest.get(u.task_id) ?? null })),
    tasks: data.tasks.map((t): RowRef => ({ key: t.task.id, task_id: t.task.id, ref: t.recent[0]?.ref ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function heading(style: Style, text: string): string {
  return style.paint("bold", text);
}

function runDetail(item: RecentItem, cols: number, ctx: RowContext): string[] {
  const { run } = item;
  const { style, tz, now } = ctx;
  const first = run.attempts[0];
  const last = run.attempts.at(-1);
  const duration = attemptDuration(run, now);
  const slot = new Date(run.slot);
  const used = run.attempts.length;
  const max = item.max_attempts;
  const attempt = used === 0 ? null : max !== null && max > 1 && (used > 1 || isFailure(run.status)) ? `attempt ${used}/${max}` : `attempt ${used}`;
  const start = first ? `started ${timeNear(new Date(first.started_at), slot, tz, now)}` : "not started";
  const facts = [statusText(style, run.status), start, ...(duration === null ? [] : [formatSpan(duration)]), ...(attempt ? [attempt] : [])];
  const agent = last?.agent ? agentCommand(last.agent) : null;
  const session = last?.session ? `${last.session.launcher}${last.session.handle ? ` (${last.session.handle})` : ""}` : null;
  const summary = runSummary(run);
  const lines = [
    heading(style, item.ref),
    facts.join(" · "),
    `${style.paint("dim", "slot")}   ${absoluteTime(slot, tz, now)}${run.trigger === "manual" ? " (manual)" : ""}`,
    ...(item.cwd ? [`${style.paint("dim", "cwd")}    ${item.cwd}`] : []),
    ...(agent || session ? [`${style.paint("dim", "agent")}  ${agent ?? "—"}${session ? ` · ${style.paint("dim", "launcher")} ${session}` : ""}`] : []),
    ...(run.reason ? [`${style.paint("dim", "reason")} ${run.reason}`] : []),
    "",
    heading(style, "Summary"),
    ...(summary ? wrap(summary, cols - 2).map((l) => `  ${l}`) : [style.paint("dim", "  —")]),
    "",
    heading(style, "Events"),
    ...(run.events.length === 0
      ? [style.paint("dim", "  none")]
      : run.events.map((e) => {
          const fields = pairs(e, ["at", "event", "notified"]);
          return `  ${style.paint("dim", eventTime(e.at, run, tz, now))} ${e.event}${fields ? ` ${style.paint("dim", fields)}` : ""}`;
        })),
  ];
  if (used > 0) lines.push("", style.paint("dim", "⏎ full log"));
  return lines;
}

function taskDetail(item: TaskItem, cols: number, ctx: RowContext): string[] {
  const { task } = item;
  const { style, tz, now } = ctx;
  const label = (text: string) => style.paint("dim", text.padEnd(9));
  const recent = item.recent.map(({ run }) => {
    const duration = attemptDuration(run, now);
    const summary = runSummary(run);
    return `  ${pad(absoluteTime(new Date(run.slot), tz, now), 12)}  ${pad(statusText(style, run.status), 11)}  ${pad(duration === null ? "—" : formatSpan(duration), 5)}${summary ? `  ${style.paint("dim", summary.split("\n")[0]!)}` : ""}`;
  });
  return [
    heading(style, task.id),
    task.title,
    `${paintMark(style, TASK_MARKS[item.row.indicator])} ${item.state} · ${item.schedule} ${style.paint("dim", `(${item.schedule_detail})`)}`,
    `${label("cwd")}${task.cwd}`,
    `${label("agent")}${item.agent} · ${style.paint("dim", "launcher")} ${item.launcher}`,
    `${label("timeout")}${item.timeout} · ${style.paint("dim", "retries")} ${item.retries} · ${style.paint("dim", "catch up")} ${item.catch_up}`,
    "",
    heading(style, `Next runs${item.next.length ? ` (${item.timezone})` : ""}`),
    ...(item.next.length === 0 ? [style.paint("dim", `  none (${item.state})`)] : item.next.map((iso) => `  ${pad(absoluteTime(new Date(iso), tz, now), 12)}  ${style.paint("dim", relativeTime(new Date(iso), now))}`)),
    "",
    heading(style, "Recent runs"),
    ...(recent.length === 0 ? [style.paint("dim", "  none")] : recent),
    "",
    heading(style, "Instructions"),
    ...wrap(task.instructions, cols - 2).map((l) => `  ${l}`),
  ];
}

function upcomingDetail(item: UpcomingItem, data: TuiData, cols: number, ctx: RowContext): string[] {
  const at = new Date(item.at);
  const head = `${heading(ctx.style, "Upcoming")} ${absoluteTime(at, ctx.tz, ctx.now)} ${ctx.style.paint("dim", `(${relativeTime(at, ctx.now)})`)}`;
  const task = data.tasks.find((t) => t.task.id === item.task_id);
  return [head, "", ...(task ? taskDetail(task, cols, ctx) : [item.task_id])];
}

/** The Detail panel's lines for the selected item, before scrolling. */
export function detailLines(model: Model, data: TuiData, cols: number, ctx: RowContext): string[] {
  const index = model.cursor[model.panel];
  if (model.panel === "recent") {
    const item = data.recent[index];
    return item ? runDetail(item, cols, ctx) : [ctx.style.paint("dim", "Runs show up here once a task's slot comes.")];
  }
  if (model.panel === "upcoming") {
    const item = data.upcoming[index];
    return item ? upcomingDetail(item, data, cols, ctx) : [ctx.style.paint("dim", "No upcoming runs: no active task.")];
  }
  const item = data.tasks[index];
  return item ? taskDetail(item, cols, ctx) : [ctx.style.paint("dim", "No tasks yet. Create one with: agent-tasks add …")];
}

// ---------------------------------------------------------------------------
// Frame pieces
// ---------------------------------------------------------------------------

function border(style: Style, left: string, right: string, cols: number, title = "", focused = false, tag = ""): string {
  const titleText = title ? ` ${title} ` : "";
  const tagText = tag ? ` ${tag} ` : "";
  const fill = Math.max(0, cols - 2 - width(titleText) - width(tagText));
  const paintedTitle = title ? (focused ? style.paint("cyan", style.paint("bold", titleText)) : titleText) : "";
  return `${style.paint("dim", left)}${paintedTitle}${style.paint("dim", "─".repeat(fill))}${style.paint("dim", tagText)}${style.paint("dim", right)}`;
}

function framed(style: Style, line: string, cols: number): string {
  return `${style.paint("dim", "│")}${fit(line, cols - 2)}${style.paint("dim", "│")}`;
}

function box(style: Style, title: string, lines: readonly string[], cols: number, rows: number, focused: boolean, tag = ""): string[] {
  const content = Array.from({ length: Math.max(0, rows - 2) }, (_, i) => framed(style, lines[i] ?? "", cols));
  return [border(style, "┌", "┐", cols, title, focused, tag), ...content, border(style, "└", "┘", cols)];
}

const HEALTH: Record<StatusInfo["health"], { text: string; color: "green" | "yellow" | "red" | "dim" }> = {
  healthy: { text: "alive", color: "green" },
  degraded: { text: "degraded", color: "yellow" },
  tick_failed: { text: "last tick failed", color: "red" },
  stopped: { text: "stopped", color: "dim" },
};

/** `12s ago`, `in 25s` under a minute (the runner can tick every 30s), else `4m ago`, `in 3m`. */
function sinceOrUntil(date: Date, now: Date): string {
  const ms = date.getTime() - now.getTime();
  if (Math.abs(ms) >= MINUTE) return relativeTime(date, now);
  const s = Math.round(Math.abs(ms) / 1000);
  return ms < 0 ? `${s}s ago` : `in ${s}s`;
}

function header({ runner, model, data, now, style, size }: ViewInput): string {
  const s = runner.status;
  // Runs that finished since the last tick are already in the data: count from it, not from the tick.
  const running = data.loaded ? data.in_progress : s.running;
  const health = model.stopping ? { text: "stopping…", color: "yellow" as const } : s.last_tick ? HEALTH[s.health] : { text: "starting…", color: "dim" as const };
  const t = s.today;
  const today = [
    [RUN_MARKS.succeeded, t.succeeded],
    [RUN_MARKS.failed, t.failed],
    [RUN_MARKS.missed, t.missed],
    [RUN_MARKS.blocked, t.blocked],
  ] as const;
  const parts = [
    `${style.paint("bold", "agent-tasks")} · runner ${style.paint(health.color, `● ${health.text}`)}`,
    `every ${runner.every}`,
    ...(s.last_tick ? [`last tick ${sinceOrUntil(s.last_tick, now)}`] : []),
    ...(s.next_tick && !model.stopping ? [`next ${sinceOrUntil(s.next_tick, now)}`] : []),
    `running ${running}`,
    `today ${today.map(([mark, n]) => style.paint(mark.color, `${mark.symbol}${n}`)).join(" ")}`,
  ];
  return fit(` ${parts.join(" · ")}`, size.width);
}

const MAIN_HINTS = "j/k move  tab panel  l detail  ⏎ log  / filter  ? help  q quit";
const DETAIL_HINTS = "j/k scroll  h back  ⏎ log  ? help  q quit";
const LOG_HINTS = "j/k scroll  gg/G top/bottom  q back";

function footer(input: ViewInput, bounds: Bounds): string {
  const { model, style, now, size } = input;
  const dim = (t: string) => style.paint("dim", t);
  if (model.search?.typing) return fit(` /${model.search.query}${style.paint("cyan", "▏")}  ${dim("⏎ keep  esc clear")}`, size.width);
  let hints = model.screen === "log" ? LOG_HINTS : model.screen === "help" ? "q back" : model.focus === "detail" ? DETAIL_HINTS : MAIN_HINTS;
  if (model.search && model.screen === "main") {
    const found = matches(model, bounds);
    const at = found.indexOf(model.cursor[model.panel]);
    hints = `${style.paint("yellow", `/${model.search.query}`)} ${found.length === 0 ? "no match" : `${at >= 0 ? `${at + 1}/` : ""}${found.length}`} · n/N next/prev · esc clear  ${hints}`;
  }
  const flash = model.flash && model.flash.until > now.getTime() ? model.flash.text : null;
  return fit(flash ? ` ${flash}  ${dim("·")}  ${dim(hints)}` : ` ${dim(hints)}`, size.width);
}

const HELP = [
  ["j / k, ↓ / ↑", "move the selection (or scroll the detail)"],
  ["gg / G", "first / last row"],
  ["Ctrl-d / Ctrl-u", "half a page down / up"],
  ["Tab / Shift-Tab", "next / previous panel"],
  ["1 2 3", "Recent, Upcoming, Tasks"],
  ["l / h", "focus the detail / back to the list"],
  ["Enter", "open the run's log (follows it while it runs)"],
  ["/", "filter by task id, then n / N for the next / previous match"],
  ["Esc", "clear the filter, leave the detail"],
  ["?", "this help"],
  ["q", "back from the log or help; on the main screen, stop the runner"],
  ["Ctrl-c", "stop the runner after the current tick (twice: at once)"],
];

function helpLines(style: Style): string[] {
  const keyWidth = Math.max(...HELP.map(([k]) => width(k!)));
  return [
    "",
    ...HELP.map(([k, what]) => `  ${style.paint("cyan", pad(k!, keyWidth))}  ${what}`),
    "",
    style.paint("dim", "  Marks: ■ ok  ✕ failed/timed out  ◐ running  □ missed  ! blocked  - superseded/cancelled  · pending"),
    style.paint("dim", "  Tasks: ● fine  ✕ failing  ◐ running  ! blocked  ⏸ paused  ○ one-off to run"),
    "",
    style.paint("dim", "  Every event is also appended to state/runner.log. Use --plain for line output."),
  ];
}

/** The log's lines as drawn: long ones wrapped to the view's width. */
function logRows(log: LogContent | null, size: Size): string[] {
  return (log?.lines ?? []).flatMap((line) => hardWrap(line, size.width - 2));
}

/** The scroll offset of the log view (the bottom while following). */
function logScroll(model: Model, lines: number, rows: number): number {
  const max = Math.max(0, lines - rows);
  return model.log?.follow ? max : Math.min(model.log?.scroll ?? 0, max);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function rowContext(input: ViewInput): RowContext {
  return { style: input.style, now: input.now, tz: input.data.timezone, query: input.model.search?.query || null };
}

/** What the keys need from the current layout (heights, line counts, rows). */
export function viewBounds(input: ViewInput): Bounds {
  const l = layout(input);
  const listHeight = { recent: 0, upcoming: 0, tasks: 0 };
  for (const s of l.sections) listHeight[s.panel] = s.rows;
  const detailCols = l.rightWidth - 2;
  const detailLinesCount = l.showDetail ? detailLines(input.model, input.data, detailCols, rowContext(input)).length : 0;
  return {
    rows: rowRefs(input.data),
    listHeight,
    detailHeight: Math.max(0, l.body - 2),
    detailLines: detailLinesCount,
    logHeight: Math.max(0, l.body - 2),
    logLines: input.model.screen === "log" ? logRows(input.log, input.size).length : 0,
  };
}

function leftColumn(input: ViewInput, l: Layout): string[] {
  const { model, data, style } = input;
  const cols = l.leftWidth;
  const ctx = rowContext(input);
  const out: string[] = [];
  l.sections.forEach(({ panel, rows }, i) => {
    const all = panelRows(panel, data, cols - 4, ctx);
    const cursor = model.cursor[panel];
    const offset = listOffset(cursor, rows);
    const focused = panel === model.panel;
    const tag = all.length > rows ? `${Math.min(cursor + 1, all.length)}/${all.length}` : "";
    out.push(border(style, i === 0 ? "┌" : "├", i === 0 ? "┐" : "┤", cols, PANEL_TITLES[panel], focused && model.focus === "list", tag));
    for (let r = 0; r < rows; r++) {
      const index = offset + r;
      const row = all[index];
      if (row === undefined) {
        out.push(framed(style, index === 0 ? style.paint("dim", `  ${EMPTY[panel]}`) : "", cols));
        continue;
      }
      const selected = focused && index === cursor;
      const marker = selected ? style.paint("cyan", "▸ ") : "  ";
      out.push(framed(style, `${marker}${selected && model.focus === "list" ? style.paint("bold", row) : row}`, cols));
    }
  });
  out.push(border(style, "└", "┘", cols));
  return out;
}

function detailColumn(input: ViewInput, l: Layout): string[] {
  const { model, data, style } = input;
  const cols = l.rightWidth;
  const rows = l.body - 2;
  const lines = detailLines(model, data, cols - 4, rowContext(input));
  const max = Math.max(0, lines.length - rows);
  const scroll = Math.min(model.detailScroll, max);
  const tag = max > 0 ? (scroll < max ? "↓ more" : "end") : "";
  return box(style, "Detail", lines.slice(scroll, scroll + rows).map((line) => ` ${line}`), cols, l.body, model.focus === "detail", tag);
}

/** The whole screen: exactly `size.height` lines, none wider than `size.width`. */
export function render(input: ViewInput): string[] {
  const { size, style, model } = input;
  const l = layout(input);
  if (l.tooSmall) {
    const lines = Array.from({ length: size.height }, () => "");
    lines[0] = fit(`Too small: ${size.width}×${size.height}, needs ${MIN_WIDTH}×${MIN_HEIGHT}`, size.width);
    if (size.height > 1) lines[1] = fit(style.paint("dim", "q quit"), size.width);
    return lines;
  }
  const bounds = viewBounds(input);
  let body: string[];
  if (model.screen === "help") {
    body = box(style, "Help", helpLines(style), size.width, l.body, true);
  } else if (model.screen === "log" && model.log) {
    const lines = logRows(input.log, size);
    const rows = l.body - 2;
    const scroll = logScroll(model, lines.length, rows);
    const state = input.log?.following ? "following" : "";
    const tag = lines.length > rows ? `${Math.min(scroll + rows, lines.length)}/${lines.length}` : "";
    body = box(style, `Log · ${model.log.ref}${state ? ` · ${state}` : ""}`, lines.slice(scroll, scroll + rows), size.width, l.body, true, tag);
  } else {
    const left = l.showList ? leftColumn(input, l) : [];
    const right = l.showDetail ? detailColumn(input, l) : [];
    body = Array.from({ length: l.body }, (_, i) => (left[i] ?? "") + (right[i] ?? ""));
  }
  return [header(input), ...body.map((line) => fit(line, size.width)), footer(input, bounds)];
}
