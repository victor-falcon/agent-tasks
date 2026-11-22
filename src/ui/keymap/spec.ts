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
export const GLOBAL_ACTIONS: readonly Action[] = ["tab_overview", "tab_tasks", "tab_runs", "tab_system", "next_tab", "prev_tab", "refresh", "help", "undo", "dismiss", "quit"];

/** Moving in a list of rows split in sections. */
export const LIST_ACTIONS: readonly Action[] = ["down", "up", "first", "last", "half_page_down", "half_page_up", "next_panel", "prev_panel", "open"];

/** Acting on the selected run or task. */
export const TARGET_ACTIONS: readonly Action[] = ["attach", "retry", "run_now", "toggle_pause"];

/** The hints every root view ends with. */
export const GLOBAL_HINTS: readonly Hint[] = [
  { actions: ["help"], label: "keys" },
  { actions: ["quit"], label: "quit" },
];
