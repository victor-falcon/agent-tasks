import { isInProgress } from "../../run-info.ts";
import type { Dashboard, DashRun } from "../../tui/snapshot.ts";
import { RETRYABLE } from "../actions.ts";
import { ACTIONS, type Action, COUNTED_ACTIONS } from "../keymap/actions.ts";
import type { Keymap } from "../keymap/config.ts";
import { GLOBAL_ACTIONS } from "../keymap/spec.ts";

// What the command palette (`:`) offers, and how a query ranks it. Pure, so
// it is tested without a renderer.
//
// - The current view's actions: the commands its keymap layer registered
//   (so exactly what its keys can run here, with the keys tui.toml gives
//   them), run as if their key had been pressed. Row motions are left out
//   (moving one row from a palette is no use).
// - Actions on a task or a run ("Run task now…", "Retry…"): the palette asks
//   for the target next, in the same box. They take the place of the view's
//   own key for the same action (which acts on the selected row), so one
//   action is listed once; the row the view is open on comes first.
// - Tasks (Enter opens the task) and recent runs (Enter opens the run).
//
// With nothing typed they come in that order of use: acting on a task or a
// run, the view's own actions, the ones of every view (tabs, reload…), then
// tasks and runs.

/** Recent runs offered (running ones first, then the newest finished). */
export const PALETTE_RUNS = 30;

/** Moving by rows or pages: no use from the palette. */
const MOTIONS: readonly Action[] = [...COUNTED_ACTIONS, "first", "last", "half_page_down", "half_page_up"];

/** Actions on a task or a run, which ask for their target: the title the palette lists, and which targets fit. */
export const ASKING_ACTIONS = {
  run_now: { title: "Run task now…", target: "task", prompt: "Run which task now?" },
  toggle_pause: { title: "Pause or resume…", target: "task", prompt: "Pause or resume which task?" },
  archive: { title: "Archive…", target: "task", prompt: "Archive which task?" },
  retry: { title: "Retry…", target: "run", prompt: "Retry which run?", accepts: (run: DashRun) => RETRYABLE.includes(run.status) },
  attach: { title: "Attach…", target: "run", prompt: "Attach to which run?", accepts: (run: DashRun) => isInProgress(run.status) },
} as const satisfies Partial<Record<Action, { title: string; target: "task" | "run"; prompt: string; accepts?: (run: DashRun) => boolean }>>;

export type AskingAction = keyof typeof ASKING_ACTIONS;

export function isAsking(action: string): action is AskingAction {
  return Object.hasOwn(ASKING_ACTIONS, action);
}

/** What choosing a row does. */
export type Pick =
  /** Runs a command of the current view's layer (as its key would). */
  | { type: "command"; command: string }
  /** Asks for the target of an action (the palette's second step). */
  | { type: "ask"; action: AskingAction }
  | { type: "open_task"; id: string }
  | { type: "open_run"; ref: string }
  /** The second step: the action on the chosen task or run. */
  | { type: "apply"; action: AskingAction; taskId: string; run: DashRun | null };

export interface PaletteItem {
  /** Unique within a list. */
  id: string;
  kind: "action" | "task" | "run";
  title: string;
  /** Dim text after the title: the action's description, a task's schedule, a run's summary. */
  detail: string;
  /** The keys that do the same here (tui.toml's), or "". */
  keys: string;
  pick: Pick;
}

export interface CatalogInput {
  /** The current view's id: its commands are `<id>.<action>`. */
  viewId: string;
  /** The commands the current view's layer registered (keymap.getCommands). */
  commands: readonly string[];
  keymap: Keymap;
  dash: Dashboard | null;
}

const keysOf = (keymap: Keymap, action: Action) => keymap[action].map((b) => b.text).join(" ");

/** First line of a summary or reason, for a run's detail. */
const firstLine = (text: string | null) => text?.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

function taskItems(dash: Dashboard | null): PaletteItem[] {
  return (dash?.next ?? []).map((task) => ({
    id: `task:${task.task_id}`,
    kind: "task",
    title: task.task_id,
    detail: [task.title, task.schedule, task.state === "paused" ? "paused" : null].filter(Boolean).join(" · "),
    keys: "",
    pick: { type: "open_task", id: task.task_id },
  }));
}

/** Running runs first, then the newest finished ones, each once. */
function recentRuns(dash: Dashboard | null): DashRun[] {
  const seen = new Set<string>();
  return [...(dash?.running ?? []), ...(dash?.recent ?? [])].filter((run) => !seen.has(run.ref) && seen.add(run.ref)).slice(0, PALETTE_RUNS);
}

function runDetail(run: DashRun): string {
  return [run.status.replace("_", " "), firstLine(run.summary) || firstLine(run.reason)].filter(Boolean).join(" · ");
}

/** The palette's first step: the view's actions, the asking actions, tasks, recent runs. */
export function paletteCatalog(input: CatalogInput): PaletteItem[] {
  const prefix = `${input.viewId}.`;
  const viewActions = input.commands.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length) as Action);
  const actions: PaletteItem[] = viewActions
    .filter((action) => action in ACTIONS && !MOTIONS.includes(action) && action !== "palette" && !isAsking(action))
    .map((action) => ({ id: `action:${action}`, kind: "action", title: ACTIONS[action], detail: action, keys: keysOf(input.keymap, action), pick: { type: "command", command: `${prefix}${action}` } }));
  const asking: PaletteItem[] = (Object.keys(ASKING_ACTIONS) as AskingAction[]).map((action) => ({
    id: `ask:${action}`,
    kind: "action",
    title: ASKING_ACTIONS[action].title,
    detail: action,
    // The view's own key does it to the selected row: worth knowing.
    keys: viewActions.includes(action) ? keysOf(input.keymap, action) : "",
    pick: { type: "ask", action },
  }));
  const runs: PaletteItem[] = recentRuns(input.dash).map((run) => ({ id: `run:${run.ref}`, kind: "run", title: run.ref, detail: runDetail(run), keys: "", pick: { type: "open_run", ref: run.ref } }));
  const isGlobal = (item: PaletteItem) => GLOBAL_ACTIONS.includes(item.detail as Action);
  return [...asking, ...actions.filter((a) => !isGlobal(a)), ...actions.filter(isGlobal), ...taskItems(input.dash), ...runs];
}

/** The palette's second step: the tasks or runs `action` can act on, the one the view is open on (`current`) first. */
export function targetItems(action: AskingAction, dash: Dashboard | null, current: { taskId?: string; ref?: string } = {}): PaletteItem[] {
  const def = ASKING_ACTIONS[action];
  let items: PaletteItem[];
  if (def.target === "task") {
    items = taskItems(dash).map((item) => ({ ...item, id: `apply:${item.title}`, pick: { type: "apply", action, taskId: item.title, run: null } }));
    if (current.taskId) items = [...items.filter((i) => i.title === current.taskId), ...items.filter((i) => i.title !== current.taskId)];
  } else {
    const accepts = "accepts" in def ? def.accepts : () => true;
    items = recentRuns(dash)
      .filter(accepts)
      .map((run) => ({ id: `apply:${run.ref}`, kind: "run", title: run.ref, detail: runDetail(run), keys: "", pick: { type: "apply", action, taskId: run.task_id, run } }));
    if (current.ref) items = [...items.filter((i) => i.title === current.ref), ...items.filter((i) => i.title !== current.ref)];
  }
  return items;
}

const WORD_START = /[\s\-_/.:·(]/;

/**
 * How well `query` matches `text`: its characters in order (case and spaces
 * ignored), more for runs of consecutive characters and for word starts;
 * null when it does not match. An empty query matches everything (0).
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const t = text.toLowerCase();
  let score = t.replace(/\s+/g, "").includes(q) ? 5 : 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += 1;
    if (i === previous + 1) score += 3;
    if (i === 0 || WORD_START.test(t[i - 1]!)) score += 2;
    previous = i;
    from = i + 1;
  }
  return score;
}

/** How well `query` matches an item: its title counts more than its detail. */
function itemScore(query: string, item: PaletteItem): number | null {
  const title = fuzzyScore(query, item.title);
  const all = fuzzyScore(query, `${item.title} ${item.detail} ${item.kind}`);
  return title !== null ? Math.max(title + 3, all ?? 0) : all;
}

/** The items matching `query`, best first (ties keep the catalog's order). */
export function rankItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  if (query.trim() === "") return [...items];
  return items
    .map((item, index) => ({ item, index, score: itemScore(query, item) }))
    .filter((r): r is { item: PaletteItem; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.item);
}
