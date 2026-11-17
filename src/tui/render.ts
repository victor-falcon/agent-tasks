import type { Color, Style } from "../output/style.ts";
import { PENDING_MARK, RUN_MARKS, TASK_MARKS } from "../output/symbols.ts";
import { renderTable } from "../output/table.ts";
import { agendaTime, clockTime, formatSpan, relativeTime } from "../output/time.ts";
import { runnerDownReason } from "../output/banner.ts";
import { type DetailView, layoutDetail } from "./detail.ts";
import { type Action, ACTIONS, type Keymap, keyHint, VIEW_ACTIONS, type View } from "./keys.ts";
import type { Dashboard, DashNext, DashRun } from "./snapshot.ts";
import { fit } from "./text.ts";

// One frame of the dashboard: exactly `height` lines of exactly `width`
// columns (the last one a column short, so the terminal never scrolls).
// Pure apart from keeping each panel's scroll offset in the state.

export type PanelId = "running" | "next" | "recent";
export const PANELS: readonly PanelId[] = ["running", "next", "recent"];

export interface ListState {
  focus: PanelId;
  cursor: Record<PanelId, number>;
  /** First visible row of each panel; render moves it to keep the cursor in view. */
  offset: Record<PanelId, number>;
}

export type DetailState = DetailView;

export interface ScreenState {
  view: View;
  list: ListState;
  detail: DetailState | null;
  help: boolean;
  /** A question waiting for y/n. */
  confirm: string | null;
  flash: { text: string; error: boolean } | null;
  /** Keys typed that start a longer binding (`g` of `gg`). */
  pending: string;
}

export function initialState(): ScreenState {
  return {
    view: "list",
    list: { focus: "recent", cursor: { running: 0, next: 0, recent: 0 }, offset: { running: 0, next: 0, recent: 0 } },
    detail: null,
    help: false,
    confirm: null,
    flash: null,
    pending: "",
  };
}

export interface FrameInput {
  dash: Dashboard;
  state: ScreenState;
  keymap: Keymap;
  /** The tui.toml in use, or null for the defaults (shown in the help). */
  keymapFile: string | null;
  width: number;
  height: number;
  style: Style;
  timezone: string;
  now: Date;
  /** `agent-tasks runner` or `agent-tasks top`. */
  title: string;
}

/** Lines of the body (everything but the title and the footer). */
export function bodyHeight(height: number): number {
  return Math.max(1, height - 2);
}

export function renderFrame(input: FrameInput): string[] {
  const { state, height, width } = input;
  const body = bodyHeight(height);
  let lines: string[];
  if (state.help) lines = [helpTitle(input), ...helpBody(input, body)];
  else if (state.view === "detail" && state.detail) {
    const shown = detailBody(input, state.detail, body); // clamps the scroll the title shows
    lines = [detailTitle(input, state.detail), ...shown];
  }
  else lines = [listTitle(input), ...listBody(input, body)];
  lines = lines.slice(0, height - 1);
  while (lines.length < height - 1) lines.push("");
  lines.push(footer(input));
  return lines.map((line, i) => fit(line, i === lines.length - 1 ? width - 1 : width));
}

// ---------------------------------------------------------------------------
// Title and footer
// ---------------------------------------------------------------------------

function todayText(style: Style, today: Dashboard["today"]): string {
  const counts = [
    [RUN_MARKS.succeeded, today.succeeded],
    [RUN_MARKS.failed, today.failed],
    [RUN_MARKS.missed, today.missed],
    [RUN_MARKS.blocked, today.blocked],
  ] as const;
  return `today ${counts.map(([mark, n]) => style.paint(n > 0 ? mark.color : "dim", `${mark.symbol}${n}`)).join(" ")}`;
}

function runnerText({ dash, style, timezone, now }: FrameInput): string {
  const r = dash.runner;
  if (r.state !== "healthy") return `${style.paint("red", "✕ runner not running")} · ${runnerDownReason(r, now)}`;
  const next = r.next_tick ? ` · next tick ${clockTime(new Date(r.next_tick), timezone)}` : "";
  return `${style.paint("green", "●")} every ${r.every} · last tick ${clockTime(new Date(r.last_tick!), timezone)}${next}`;
}

/** Left and right parts on one line, the right one flush with the edge when there is room. */
function spread(left: string, right: string, width: number): string {
  if (right === "") return left;
  const gap = width - Bun.stringWidth(left) - Bun.stringWidth(right);
  return gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : `${left}  ${right}`;
}

function listTitle(input: FrameInput): string {
  const { style, dash, width } = input;
  return spread(`${style.paint("bold", input.title)} · ${runnerText(input)}`, todayText(style, dash.today), width);
}

function hints(keymap: Keymap, items: [Action | Action[], string][]): string {
  return items
    .map(([actions, label]) => {
      const keys = (Array.isArray(actions) ? actions : [actions]).map((a) => keyHint(keymap, a)).filter((k) => k !== null);
      return keys.length > 0 ? `${keys.join("/")} ${label}` : null;
    })
    .filter((h) => h !== null)
    .join(" · ");
}

function footer({ state, style, keymap, width }: FrameInput): string {
  if (state.confirm) return style.paint("yellow", `${state.confirm} [y/N]`);
  const pending = state.pending ? style.paint("yellow", state.pending) : "";
  if (state.flash) return spread(style.paint(state.flash.error ? "red" : "cyan", state.flash.text), pending, width);
  let text: string;
  if (state.help) text = "any key to close";
  else if (state.view === "detail") {
    text = hints(keymap, [
      [["down", "up"], "scroll"],
      [["prev_section", "next_section"], "section"],
      ["toggle_section", "fold/open"],
      ["attach", "attach"],
      ["retry", "retry"],
      ["back", "back"],
      ["help", "keys"],
    ]);
  } else {
    text = hints(keymap, [
      [["down", "up"], "move"],
      ["next_panel", "panel"],
      ["open", "open"],
      ["attach", "attach"],
      ["retry", "retry"],
      ["run_now", "run"],
      ["toggle_pause", "pause"],
      ["help", "keys"],
      ["quit", "quit"],
    ]);
  }
  return spread(style.paint("dim", text), pending, width);
}

// ---------------------------------------------------------------------------
// The panels
// ---------------------------------------------------------------------------

interface Panel {
  id: PanelId | "events";
  title: string;
  /** Rows as plain text (for the selected row) and styled. */
  plain: string[];
  styled: string[];
  empty: string;
  /** Rows to show when the screen is tall enough. */
  wanted: number;
}

/** Builds aligned rows twice, without and with colors (same widths). */
function rows(cells: (style: Style) => string[][], style: Style, plainStyle: Style): { plain: string[]; styled: string[] } {
  const table = (s: Style) => {
    const c = cells(s);
    return c.length === 0 ? [] : renderTable(c, { header: false }).split("\n");
  };
  return { plain: table(plainStyle), styled: table(style) };
}

const PLAIN: Style = { enabled: false, paint: (_c, t) => t };

function machineCell(style: Style, machine: string | null, show: boolean): string[] {
  return show ? [style.paint("dim", machine ?? "")] : [];
}

function runningCells(style: Style, runs: readonly DashRun[], { timezone, now }: FrameInput, showMachine: boolean): string[][] {
  return runs.map((r) => {
    const mark = RUN_MARKS[r.status];
    const since = r.started_at ? new Date(r.started_at) : null;
    return [
      style.paint(mark.color, mark.symbol),
      r.task_id,
      style.paint(mark.color, r.status),
      since ? `since ${clockTime(since, timezone)}` : "",
      since ? formatSpan(now.getTime() - since.getTime()) : "",
      r.attempt > 1 ? `attempt ${r.attempt}` : "",
      style.paint("dim", r.handle ?? ""),
      ...machineCell(style, r.machine, showMachine),
    ];
  });
}

function nextCells(style: Style, next: readonly DashNext[], { timezone, now }: FrameInput, showMachine: boolean): string[][] {
  return next.map((n) => {
    if (n.at === null) {
      const mark = TASK_MARKS.paused;
      return [style.paint(mark.color, mark.symbol), style.paint("dim", "paused"), style.paint("dim", n.task_id), "", style.paint("dim", n.schedule), ...machineCell(style, n.machine, showMachine)];
    }
    const at = new Date(n.at);
    return [style.paint(PENDING_MARK.color, "○"), agendaTime(at, timezone, now), n.task_id, relativeTime(at, now), style.paint("dim", n.schedule), ...machineCell(style, n.machine, showMachine)];
  });
}

function recentCells(style: Style, recent: readonly DashRun[], { timezone, now }: FrameInput, showMachine: boolean): string[][] {
  return recent.map((r) => {
    const mark = RUN_MARKS[r.status];
    const took = r.started_at && r.finished_at ? formatSpan(Date.parse(r.finished_at) - Date.parse(r.started_at)) : "–";
    const what = r.summary ?? (r.reason ? style.paint("dim", r.reason) : "");
    return [
      style.paint(mark.color, mark.symbol),
      agendaTime(new Date(r.at), timezone, now),
      r.task_id,
      ...machineCell(style, r.machine, showMachine),
      took,
      r.attempt > 1 ? `×${r.attempt}` : "",
      what.split("\n")[0]!,
    ];
  });
}

/** Colors of the marks runner.log uses. */
const LOG_MARKS: Record<string, Color> = { "▶": "cyan", "■": "green", "✕": "red", "□": "yellow", "!": "magenta", "⚠": "yellow", "↻": "yellow", "●": "green", "○": "dim" };

/** One line of runner.log, taken apart to be shown in columns. */
export interface LogEvent {
  /** `13:07:15`, or "" for lines written before runner.log carried the time on every line. */
  time: string;
  mark: string;
  /** The task, for run events; null for the runner's own lines. */
  task: string | null;
  /** What happened: `succeeded in 15s`, `runner started · every 5m`… */
  what: string;
  /** The agent's summary or an error, when there is one. */
  note: string;
}

/** A runner.log line as columns, or null for the lines not worth showing (the tick heartbeats). */
export function parseLogLine(line: string): LogEvent | null {
  const timed = /^(\d\d:\d\d:\d\d) {2}(.*)$/.exec(line);
  const time = timed ? timed[1]! : "";
  const rest = timed ? timed[2]! : line;
  if (rest.trim() === "" || /^tick {2}/.test(rest)) return null;
  const header = /^agent-tasks runner · (.*)$/.exec(rest);
  if (header) {
    const parts = header[1]!.split(" · ").filter((p) => !p.startsWith("data: ")).map((p) => p.replace(/^launcher: /, ""));
    return { time, mark: "●", task: null, what: ["runner started", ...parts].join(" · "), note: "" };
  }
  const final = /^● (.+?) · last tick /.exec(rest);
  if (final) {
    // `degraded (see ⚠ above)` → `degraded`: the screen's pointer means nothing here.
    const health = final[1]!.split(" (")[0]!;
    return { time, mark: "○", task: null, what: health === "stopped" ? "runner stopped" : health === "healthy" ? "runner exited" : `runner exited (${health})`, note: "" };
  }
  const event = /^(\S) (.*)$/.exec(rest);
  if (!event) return { time, mark: " ", task: null, what: rest, note: "" };
  const [, mark, body] = event as unknown as [string, string, string];
  // Run events put the run ref (or a task id) first, padded so the details
  // line up: a run ref, or a task id followed by the padding. Anything else
  // (warnings, recoveries) is the runner's own text.
  const ref = /^([\w.-]+\/\d{8}T\d{4,6}Z) +(.*)$/.exec(body) ?? /^([\w.-]+) {2,}(.*)$/.exec(body);
  if (!ref) return { time, mark, task: null, what: body, note: "" };
  const task = ref[1]!.split("/")[0]!;
  // The command hints at the end are for the terminal; here the run is a key away.
  const detail = ref[2]!.replace(/ · agent-tasks (log|attach) \S+$/, "");
  const cut = detail.indexOf(" · ");
  const what = cut === -1 ? detail : detail.slice(0, cut);
  const note = cut === -1 ? "" : detail.slice(cut + 3).replace(/^"([\s\S]*)"$/, "$1");
  return { time, mark, task, what, note };
}

/** Widest a column of the Events panel gets before it is cut. */
const EVENT_TASK_WIDTH = 32;
const EVENT_WHAT_WIDTH = 30;

/** runner.log in columns: time, mark, task, what happened, and the summary dimmed. */
function eventRows(style: Style, lines: readonly string[]): { plain: string[]; styled: string[] } {
  const events: LogEvent[] = [];
  for (const e of lines.map(parseLogLine)) {
    if (e === null) continue;
    // A stop right before a start is one restart.
    const previous = events.at(-1);
    if (e.mark === "●" && previous?.mark === "○" && previous.what === "runner stopped") {
      events[events.length - 1] = { ...e, time: e.time || previous.time, what: e.what.replace("runner started", "runner restarted") };
    } else events.push(e);
  }
  events.splice(0, Math.max(0, events.length - 50));
  const width = (texts: string[], max: number) => Math.min(max, Math.max(0, ...texts.map((t) => Bun.stringWidth(t))));
  const taskWidth = width(events.map((e) => e.task ?? ""), EVENT_TASK_WIDTH);
  const whatWidth = width(events.filter((e) => e.task !== null).map((e) => e.what), EVENT_WHAT_WIDTH);
  const row = (e: LogEvent, s: Style): string => {
    const color = LOG_MARKS[e.mark];
    const time = s.paint("dim", e.time.padEnd(8));
    const mark = s.paint(color, e.mark);
    if (e.task === null) return `${time}  ${mark} ${s.paint(e.mark === "●" || e.mark === "○" ? "dim" : color, e.what)}`;
    const what = fit(e.what, whatWidth);
    const outcome = e.mark === "■" || e.mark === "✕" || e.mark === "□" || e.mark === "!" ? s.paint(color, what) : what;
    return `${time}  ${mark} ${fit(e.task, taskWidth)}  ${outcome}${e.note ? `  ${s.paint("dim", e.note.split("\n")[0]!)}` : ""}`.trimEnd();
  };
  return { plain: events.map((e) => row(e, PLAIN)), styled: events.map((e) => row(e, style)) };
}

/** Rows the Events panel always gets, when Recent has enough. */
const EVENTS_MIN_ROWS = 6;

/**
 * Rows per panel: what each wants, shrunk (events first) until Recent has a
 * few. Room that Recent does not need goes to the events.
 */
function layout(panels: Panel[], body: number): number[] {
  const sizes = panels.map((p) => Math.max(1, p.wanted));
  const eventsIndex = panels.findIndex((p) => p.id === "events");
  const recent = panels.find((p) => p.id === "recent");
  if (eventsIndex >= 0 && recent) {
    const others = sizes.reduce((sum, n, i) => (panels[i] === recent || i === eventsIndex ? sum : sum + n), 0) + panels.length;
    const spare = body - others - Math.max(3, recent.plain.length);
    sizes[eventsIndex] = Math.min(sizes[eventsIndex]!, Math.max(EVENTS_MIN_ROWS, spare));
  }
  const recentIndex = panels.findIndex((p) => p.id === "recent");
  const fixed = () => sizes.reduce((sum, n, i) => (i === recentIndex ? sum : sum + n), 0) + panels.length;
  const shrinkOrder = ["events", "next", "running"];
  while (body - fixed() < 3) {
    const victim = shrinkOrder.map((id) => panels.findIndex((p) => p.id === id)).find((i) => i >= 0 && sizes[i]! > 1);
    if (victim === undefined) break;
    sizes[victim]!--;
  }
  sizes[recentIndex] = Math.max(1, body - fixed());
  return sizes;
}

function panelTitle(style: Style, panel: Panel, focused: boolean, count: number, width: number): string {
  const label = ` ${panel.title}${panel.id === "events" ? "" : ` (${count})`} `;
  const rule = `──${label}${"─".repeat(Math.max(0, width - label.length - 2))}`;
  return focused ? style.paint("bold", style.paint("cyan", rule)) : style.paint("dim", rule);
}

function listBody(input: FrameInput, body: number): string[] {
  const { dash, style, state, width } = input;
  const showMachine = new Set([...dash.running, ...dash.recent].map((r) => r.machine).filter((m) => m !== null)).size > 1;
  const panel = (id: Panel["id"], title: string, built: { plain: string[]; styled: string[] }, empty: string, wanted: number): Panel => ({ id, title, ...built, empty, wanted });
  const panels: Panel[] = [
    panel("running", "Running", rows((s) => runningCells(s, dash.running, input, showMachine), style, PLAIN), "nothing running", Math.min(Math.max(dash.running.length, 1), 4)),
    panel("next", "Next", rows((s) => nextCells(s, dash.next, input, showMachine), style, PLAIN), "nothing scheduled", Math.min(Math.max(dash.next.length, 1), 6)),
    panel("recent", "Recent", rows((s) => recentCells(s, dash.recent, input, showMachine), style, PLAIN), "no runs yet", 0),
  ];
  const events = eventRows(style, dash.events);
  panels.push(panel("events", "Events", events, "no events yet", events.plain.length));
  const sizes = layout(panels, body);
  const out: string[] = [];
  panels.forEach((p, i) => {
    const size = sizes[i]!;
    const focusable = p.id !== "events";
    const focused = focusable && state.list.focus === p.id;
    out.push(panelTitle(style, p, focused, p.plain.length, width));
    if (p.plain.length === 0) {
      out.push(`  ${style.paint("dim", p.empty)}`, ...Array(size - 1).fill(""));
      return;
    }
    let first: number;
    let cursor = -1;
    if (focusable) {
      const id = p.id as PanelId;
      cursor = Math.min(state.list.cursor[id], p.plain.length - 1);
      state.list.cursor[id] = cursor;
      first = keepInView(state.list.offset[id], cursor, size, p.plain.length);
      state.list.offset[id] = first;
    } else first = Math.max(0, p.plain.length - size); // events: the newest at the bottom
    for (let row = 0; row < size; row++) {
      const n = first + row;
      if (n >= p.plain.length) {
        out.push("");
        continue;
      }
      if (n === cursor && focused) out.push(style.paint("inverse", fit(`› ${p.plain[n]}`, width)));
      else out.push(`  ${p.styled[n]}`);
    }
  });
  return out;
}

/** The first visible row so that `cursor` is on screen, moving as little as possible. */
export function keepInView(offset: number, cursor: number, rows: number, count: number): number {
  let first = offset;
  if (cursor < first) first = cursor;
  if (cursor >= first + rows) first = cursor - rows + 1;
  return Math.max(0, Math.min(first, Math.max(0, count - rows)));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function detailTitle({ style, width, height }: FrameInput, view: DetailState): string {
  const body = bodyHeight(height);
  const total = layoutDetail(view, style).lines.length;
  const where = total > body ? style.paint("dim", ` · ${Math.min(100, Math.round(((view.scroll + body) / total) * 100))}%`) : "";
  return spread(style.paint("bold", view.detail.ref), `${view.detail.status}${where}`, width);
}

/** Highest scroll position: the last line at the bottom. */
export function maxScroll(view: DetailState, style: Style, body: number): number {
  return Math.max(0, layoutDetail(view, style).lines.length - body);
}

function detailBody({ style }: FrameInput, view: DetailState, body: number): string[] {
  const { lines } = layoutDetail(view, style);
  view.scroll = Math.max(0, Math.min(view.scroll, Math.max(0, lines.length - body)));
  return lines.slice(view.scroll, view.scroll + body);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpTitle({ style, keymapFile }: FrameInput): string {
  return `${style.paint("bold", "Keys")} ${style.paint("dim", keymapFile ? `from ${keymapFile}` : "(defaults; change them in tui.toml in the config folder)")}`;
}

function helpBody({ style, keymap, state }: FrameInput, _body: number): string[] {
  const actions = VIEW_ACTIONS[state.view];
  const table = renderTable(
    actions.map((a) => [keymap[a].map((b) => b.text).join(" ") || style.paint("dim", "(unbound)"), style.paint("dim", a), ACTIONS[a]]),
    { header: false, indent: "  " },
  );
  return ["", ...table.split("\n"), "", style.paint("dim", "  Ctrl-C always quits. Keys use Vim notation: gg, G, <C-d>, <CR>, <Esc>, <Tab>, <S-Tab>, <C-w>j…")];
}
