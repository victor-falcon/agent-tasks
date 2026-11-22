import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

/** Actions only this view has (name → description and default keys). */
export const RUN_ACTIONS = {
  close_session: { desc: "Close the run's session (kept open, or still running)", keys: ["c"] },
  go_to_task: { desc: "Go to the run's task", keys: ["t"] },
  open_output: { desc: "Open the run's output file in $PAGER", keys: ["o"] },
  copy_ref: { desc: "Copy the run's ref", keys: ["y"] },
  copy_summary: { desc: "Copy the run's summary", keys: ["Y"] },
  search_log: { desc: "Search the run's log", keys: ["/"] },
  next_match: { desc: "Next match in the log", keys: ["n"] },
  prev_match: { desc: "Previous match in the log", keys: ["N"] },
} as const satisfies ActionDefs;

export const RUN_KEYS: ViewKeys = {
  id: "run",
  actions: [
    // `q` and `<Esc>` go back here, as in the old dashboard's run view.
    ...GLOBAL_ACTIONS.filter((a) => a !== "quit" && a !== "dismiss"),
    "back",
    "down",
    "up",
    "first",
    "last",
    "half_page_down",
    "half_page_up",
    "next_section",
    "prev_section",
    "toggle_section",
    "open_sections",
    "fold_sections",
    "attach",
    "retry",
    "run_now",
    "close_session",
    "go_to_task",
    "open_output",
    "copy_ref",
    "copy_summary",
    "search_log",
    "next_match",
    "prev_match",
  ],
  hints: [
    { actions: ["down", "up"], label: "sections" },
    { actions: ["toggle_section"], label: "fold" },
    { actions: ["attach"], label: "attach" },
    { actions: ["retry"], label: "retry" },
    { actions: ["go_to_task"], label: "task" },
    { actions: ["search_log"], label: "search" },
    { actions: ["back"], label: "back" },
    { actions: ["help"], label: "keys" },
  ],
};
