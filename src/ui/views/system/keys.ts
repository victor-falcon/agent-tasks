import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, GLOBAL_HINTS, LIST_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

/**
 * Actions only this view has (name → description and default keys). The
 * names are generic where another view may mean the same (`search`,
 * `search_next`, `recheck`), so one tui.toml line remaps them everywhere.
 * `cycle_filter` and `copy` are the Runs tab's actions, bound here too.
 */
export const SYSTEM_ACTIONS = {
  search: { desc: "Search the text shown (⏎ keeps it, <Esc> clears it)", keys: ["/"] },
  search_next: { desc: "Next match of the search", keys: ["n"] },
  search_prev: { desc: "Previous match of the search", keys: ["N"] },
  toggle_follow: { desc: "Follow the end of the log as lines arrive (on or off)", keys: ["F"] },
  tick_now: { desc: "Run one tick of the runner now (it may launch due runs)", keys: ["T"] },
  recheck: { desc: "Check again: machines (in Machines) or doctor (elsewhere)", keys: ["c"] },
} as const satisfies ActionDefs;

// Tab / Shift-Tab (next_panel / prev_panel) move between the panes; j/k move
// in the events or scroll the focused pane. `y` copy and `N` are left out of
// the footer to keep it on one line at 100 columns; `?` lists them.
export const SYSTEM_KEYS: ViewKeys = {
  id: "system",
  actions: [...GLOBAL_ACTIONS, ...LIST_ACTIONS, "cycle_filter", "copy", "search", "search_next", "search_prev", "toggle_follow", "tick_now", "recheck"],
  hints: [
    { actions: ["next_panel"], label: "pane" },
    { actions: ["open"], label: "open" },
    { actions: ["search"], label: "search" },
    { actions: ["cycle_filter"], label: "level" },
    { actions: ["toggle_follow"], label: "follow" },
    { actions: ["recheck"], label: "check" },
    { actions: ["tick_now"], label: "tick" },
    ...GLOBAL_HINTS,
  ],
};
