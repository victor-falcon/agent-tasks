import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, GLOBAL_HINTS, LIST_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

/**
 * Actions only this view has (name → description and default keys). The
 * names are generic on purpose (`cycle_filter`, `goto_task`, `copy`): other
 * list views can bind the same action, so one tui.toml line remaps it
 * everywhere.
 */
export const RUNS_ACTIONS = {
  cycle_filter: { desc: "Cycle the list's main filter", keys: ["f"] },
  cycle_since: { desc: "Cycle how far back the list goes (24h · 7d · 30d · all)", keys: ["S"] },
  goto_task: { desc: "Go to the selected run's task", keys: ["t"] },
  copy: { desc: "Copy the selected item's ref or id", keys: ["y"] },
} as const satisfies ActionDefs;

// `t` task and `y` copy are left out of the footer to keep it on one line at 100 columns; `?` lists them.
export const RUNS_KEYS: ViewKeys = {
  id: "runs",
  actions: [...GLOBAL_ACTIONS, ...LIST_ACTIONS, "attach", "retry", "filter", "cycle_filter", "cycle_since", "goto_task", "copy"],
  hints: [
    { actions: ["down", "up"], label: "move" },
    { actions: ["open"], label: "open" },
    { actions: ["filter"], label: "filter" },
    { actions: ["cycle_filter"], label: "status" },
    { actions: ["cycle_since"], label: "since" },
    { actions: ["retry"], label: "retry" },
    { actions: ["attach"], label: "attach" },
    ...GLOBAL_HINTS,
  ],
};
