import type { Key } from "./keys.ts";

// The state of the runner's view and how keys change it. Pure: no terminal,
// no files, no clock (the time comes in as an argument), so every key can be
// tested. The IO layer (screen.ts) turns the returned effects into actions.

export const PANELS = ["recent", "upcoming", "tasks"] as const;
export type Panel = (typeof PANELS)[number];

export const PANEL_TITLES: Record<Panel, string> = { recent: "Recent", upcoming: "Upcoming", tasks: "Tasks" };

/** How long a runner event stays on the bottom line. */
export const FLASH_MS = 6_000;

export interface Model {
  screen: "main" | "help" | "log";
  panel: Panel;
  /** `list`: j/k move the selection; `detail`: j/k scroll the detail. */
  focus: "list" | "detail";
  cursor: Record<Panel, number>;
  detailScroll: number;
  /** The log view: which run, its scroll, and whether it sticks to the bottom (new output scrolls into view). */
  log: { ref: string; scroll: number; follow: boolean } | null;
  /** `/` search on task ids: `typing` while the query is being written. */
  search: { query: string; typing: boolean } | null;
  /** The first key of a two-key command (`g` of `gg`). */
  pending: string | null;
  /** The latest runner event, shown on the bottom line until `until`. */
  flash: { text: string; until: number } | null;
  /** `q` was pressed: the runner stops after the current tick. */
  stopping: boolean;
}

/** One row of a list panel, as far as keys care. */
export interface RowRef {
  /** Stable across refreshes (run ref, task id + slot, task id). */
  key: string;
  task_id: string;
  /** The run Enter opens, if any. */
  ref: string | null;
}

/** What the keys need to know about the current screen (from the renderer's layout). */
export interface Bounds {
  rows: Record<Panel, readonly RowRef[]>;
  /** Visible rows of each list panel (0 when the panel is hidden). */
  listHeight: Record<Panel, number>;
  detailHeight: number;
  detailLines: number;
  logHeight: number;
  logLines: number;
}

export type Effect =
  | { type: "quit" }
  | { type: "open-log"; ref: string }
  | { type: "close-log" }
  /** Redraw the whole screen (Ctrl-L). */
  | { type: "redraw" }
  /** A short message on the bottom line. */
  | { type: "notice"; text: string };

export interface Update {
  model: Model;
  effects: Effect[];
}

export function initialModel(): Model {
  return {
    screen: "main",
    panel: "recent",
    focus: "list",
    cursor: { recent: 0, upcoming: 0, tasks: 0 },
    detailScroll: 0,
    log: null,
    search: null,
    pending: null,
    flash: null,
    stopping: false,
  };
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** The highest scroll offset that still fills the view. */
function maxScroll(lines: number, height: number): number {
  return Math.max(0, lines - Math.max(1, height));
}

/** The rows of the current panel whose task id contains the query. */
export function matches(model: Model, bounds: Bounds, panel: Panel = model.panel): number[] {
  const query = model.search?.query.toLowerCase();
  if (!query) return [];
  return bounds.rows[panel].flatMap((row, i) => (row.task_id.toLowerCase().includes(query) ? [i] : []));
}

export function selectedRow(model: Model, bounds: Bounds): RowRef | null {
  return bounds.rows[model.panel][model.cursor[model.panel]] ?? null;
}

function select(model: Model, panel: Panel, index: number, bounds: Bounds): Model {
  const count = bounds.rows[panel].length;
  const cursor = { ...model.cursor, [panel]: clamp(index, 0, Math.max(0, count - 1)) };
  const moved = cursor[panel] !== model.cursor[panel] || panel !== model.panel;
  return { ...model, panel, cursor, detailScroll: moved ? 0 : model.detailScroll };
}

/** Jumps to a match in the current panel: `dir` 1 next, -1 previous, 0 the cursor itself or the next one. Wraps around. */
function jumpToMatch(model: Model, bounds: Bounds, dir: 1 | -1 | 0): Model {
  const found = matches(model, bounds);
  if (found.length === 0) return model;
  const at = model.cursor[model.panel];
  const next = dir === -1 ? (found.filter((i) => i < at).at(-1) ?? found.at(-1)!) : (found.find((i) => (dir === 0 ? i >= at : i > at)) ?? found[0]!);
  return { ...select(model, model.panel, next, bounds), focus: "list" };
}

/** Moves the selection (list focus) or the detail scroll (detail focus) by `delta` rows. */
function move(model: Model, bounds: Bounds, delta: number): Model {
  if (model.focus === "detail") {
    return { ...model, detailScroll: clamp(model.detailScroll + delta, 0, maxScroll(bounds.detailLines, bounds.detailHeight)) };
  }
  return select(model, model.panel, model.cursor[model.panel] + delta, bounds);
}

function halfPage(model: Model, bounds: Bounds): number {
  const height = model.focus === "detail" ? bounds.detailHeight : bounds.listHeight[model.panel];
  return Math.max(1, Math.floor(height / 2));
}

function scrollLog(model: Model, bounds: Bounds, to: number): Model {
  if (!model.log) return model;
  const max = maxScroll(bounds.logLines, bounds.logHeight);
  const scroll = clamp(to, 0, max);
  return { ...model, log: { ...model.log, scroll, follow: scroll >= max } };
}

function logKey(model: Model, key: Key, bounds: Bounds): Update {
  const log = model.log!;
  // While following, the view is at the bottom whatever `scroll` says.
  const at = log.follow ? maxScroll(bounds.logLines, bounds.logHeight) : log.scroll;
  const half = Math.max(1, Math.floor(bounds.logHeight / 2));
  const done = (m: Model): Update => ({ model: { ...m, pending: null }, effects: [] });
  if (model.pending === "g") return done(key === "g" ? scrollLog(model, bounds, 0) : model);
  switch (key) {
    case "q":
    case "esc":
    case "h":
    case "left":
      return { model: { ...model, screen: "main", log: null, pending: null }, effects: [{ type: "close-log" }] };
    case "j":
    case "down":
      return done(scrollLog(model, bounds, at + 1));
    case "k":
    case "up":
      return done(scrollLog(model, bounds, at - 1));
    case "ctrl-d":
    case "pagedown":
    case " ":
      return done(scrollLog(model, bounds, at + half));
    case "ctrl-u":
    case "pageup":
      return done(scrollLog(model, bounds, at - half));
    case "G":
    case "end":
      return done(scrollLog(model, bounds, Number.MAX_SAFE_INTEGER));
    case "home":
      return done(scrollLog(model, bounds, 0));
    case "g":
      return { model: { ...model, pending: "g" }, effects: [] };
    case "?":
      return done({ ...model, screen: "help" });
    default:
      return done(model);
  }
}

function searchKey(model: Model, key: Key, bounds: Bounds): Update {
  const query = model.search!.query;
  const typed = (q: string): Update => {
    const m = { ...model, search: { query: q, typing: true } };
    return { model: q ? jumpToMatch(m, bounds, 0) : m, effects: [] };
  };
  if (key === "enter") return { model: { ...model, search: query ? { query, typing: false } : null }, effects: [] };
  if (key === "esc") return { model: { ...model, search: null }, effects: [] };
  if (key === "backspace") return query === "" ? { model: { ...model, search: null }, effects: [] } : typed(query.slice(0, -1));
  if ([...key].length === 1) return typed(query + key);
  return { model, effects: [] };
}

function mainKey(model: Model, key: Key, bounds: Bounds): Update {
  const done = (m: Model): Update => ({ model: { ...m, pending: null }, effects: [] });
  if (model.pending === "g") {
    if (key === "g") return done(model.focus === "detail" ? { ...model, detailScroll: 0 } : select(model, model.panel, 0, bounds));
    model = { ...model, pending: null }; // not `gg`: the key counts on its own
  }
  const panelIndex = PANELS.indexOf(model.panel);
  const toPanel = (panel: Panel): Update => done({ ...model, panel, focus: "list", detailScroll: panel === model.panel ? model.detailScroll : 0 });
  switch (key) {
    case "j":
    case "down":
      return done(move(model, bounds, 1));
    case "k":
    case "up":
      return done(move(model, bounds, -1));
    case "ctrl-d":
    case "pagedown":
      return done(move(model, bounds, halfPage(model, bounds)));
    case "ctrl-u":
    case "pageup":
      return done(move(model, bounds, -halfPage(model, bounds)));
    case "g":
      return { model: { ...model, pending: "g" }, effects: [] };
    case "G":
    case "end":
      return done(model.focus === "detail" ? { ...model, detailScroll: maxScroll(bounds.detailLines, bounds.detailHeight) } : select(model, model.panel, Number.MAX_SAFE_INTEGER, bounds));
    case "home":
      return done(model.focus === "detail" ? { ...model, detailScroll: 0 } : select(model, model.panel, 0, bounds));
    case "tab":
      return toPanel(PANELS[(panelIndex + 1) % PANELS.length]!);
    case "shift-tab":
      return toPanel(PANELS[(panelIndex + PANELS.length - 1) % PANELS.length]!);
    case "1":
    case "2":
    case "3":
      return toPanel(PANELS[Number(key) - 1]!);
    case "l":
    case "right":
      return done({ ...model, focus: "detail" });
    case "h":
    case "left":
      return done({ ...model, focus: "list" });
    case "enter": {
      const ref = selectedRow(model, bounds)?.ref;
      if (!ref) return { model: { ...model, pending: null }, effects: [{ type: "notice", text: "no run to open yet" }] };
      return { model: { ...model, screen: "log", log: { ref, scroll: 0, follow: false }, pending: null }, effects: [{ type: "open-log", ref }] };
    }
    case "/":
      return done({ ...model, search: { query: "", typing: true } });
    case "n":
      return done(model.search ? jumpToMatch(model, bounds, 1) : model);
    case "N":
      return done(model.search ? jumpToMatch(model, bounds, -1) : model);
    case "?":
      return done({ ...model, screen: "help" });
    case "esc":
      if (model.search) return done({ ...model, search: null });
      return done(model.focus === "detail" ? { ...model, focus: "list" } : model);
    case "q":
      if (model.stopping) return done(model);
      return { model: { ...model, stopping: true, pending: null }, effects: [{ type: "quit" }] };
    default:
      return done(model);
  }
}

/** A key on any screen. Ctrl-C always quits (a second one, handled by the caller, exits at once). */
export function update(model: Model, key: Key, bounds: Bounds): Update {
  if (key === "ctrl-l") return { model, effects: [{ type: "redraw" }] };
  if (key === "ctrl-c") return { model: { ...model, stopping: true, pending: null }, effects: [{ type: "quit" }] };
  if (model.screen === "help") {
    if (key === "q" || key === "esc" || key === "?") return { model: { ...model, screen: model.log ? "log" : "main" }, effects: [] };
    return { model, effects: [] };
  }
  if (model.screen === "log" && model.log) return logKey(model, key, bounds);
  if (model.search?.typing) return searchKey(model, key, bounds);
  return mainKey(model, key, bounds);
}

/** The opened log is of a run in progress: show its latest output and stick to it. */
export function followLog(model: Model): Model {
  return model.log ? { ...model, log: { ...model.log, follow: true } } : model;
}

/** Shows a runner event on the bottom line for a few seconds. */
export function flash(model: Model, text: string, now: number): Model {
  return { ...model, flash: { text, until: now + FLASH_MS } };
}

/**
 * After the data changed: keeps each panel's selection on the same item
 * (new runs push the old ones down), or clamps it when the item is gone.
 */
export function reanchor(model: Model, before: Bounds["rows"], after: Bounds["rows"]): Model {
  const cursor = { ...model.cursor };
  for (const panel of PANELS) {
    const key = before[panel][cursor[panel]]?.key;
    const found = key === undefined ? -1 : after[panel].findIndex((r) => r.key === key);
    cursor[panel] = found >= 0 ? found : clamp(cursor[panel], 0, Math.max(0, after[panel].length - 1));
  }
  const same = before[model.panel][model.cursor[model.panel]]?.key === after[model.panel][cursor[model.panel]]?.key;
  return { ...model, cursor, detailScroll: same ? model.detailScroll : 0 };
}
