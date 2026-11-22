import type { Action } from "./actions.ts";

// What a view listens to: the full set of actions bound while it is shown
// (tui.toml conflicts are checked within that set), and the footer hints.
// Pure data, so `config check` can validate tui.toml without loading the UI.

export interface Hint {
  /** Their first keys are shown joined: `j/k move`. */
  actions: readonly Action[];
  label: string;
}

export interface ViewKeys {
  /** The view's id, also used in conflict messages ("in the overview view"). */
  id: string;
  actions: readonly Action[];
  hints: readonly Hint[];
}

/** What works on every root tab. */
export const GLOBAL_ACTIONS: readonly Action[] = ["tab_overview", "tab_tasks", "tab_runs", "tab_system", "next_tab", "prev_tab", "refresh", "help", "palette", "undo", "dismiss", "quit"];

/** Moving in a list of rows split in sections. */
export const LIST_ACTIONS: readonly Action[] = ["down", "up", "first", "last", "half_page_down", "half_page_up", "next_panel", "prev_panel", "open"];

/** Acting on the selected run or task. */
export const TARGET_ACTIONS: readonly Action[] = ["attach", "retry", "run_now", "toggle_pause"];

/** The hints every root view ends with. */
export const GLOBAL_HINTS: readonly Hint[] = [
  { actions: ["help"], label: "keys" },
  { actions: ["quit"], label: "quit" },
];

/** A tab that is not built yet: only the global keys. */
export function placeholderTabKeys(id: string): ViewKeys {
  return { id, actions: GLOBAL_ACTIONS, hints: [{ actions: ["tab_overview"], label: "overview" }, ...GLOBAL_HINTS] };
}

/** A detail view that is not built yet: back and the global keys (`q` and `<Esc>` go back here). */
export function placeholderDetailKeys(id: string): ViewKeys {
  return { id, actions: [...GLOBAL_ACTIONS.filter((a) => a !== "quit" && a !== "dismiss"), "back"], hints: [{ actions: ["back"], label: "back" }, { actions: ["help"], label: "keys" }] };
}
