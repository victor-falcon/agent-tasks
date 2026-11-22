import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";
import { TASK_TARGET_ACTIONS } from "../tasks/keys.ts";

/** Actions only this view has (name → description and default keys). */
export const TASK_ACTIONS = {
  next_subtab: { desc: "Next part of the task (Overview, Instructions, Runs, Settings)", keys: ["]"] },
  prev_subtab: { desc: "Previous part of the task", keys: ["["] },
  toggle_instructions: { desc: "Instructions as written / as the agent receives them", keys: ["i"] },
} as const satisfies ActionDefs;

/** `q` and `<Esc>` go back here, as in every detail. */
export const TASK_KEYS: ViewKeys = {
  id: "task",
  actions: [
    ...GLOBAL_ACTIONS.filter((a) => a !== "quit" && a !== "dismiss"),
    "back",
    "down",
    "up",
    "first",
    "last",
    "half_page_down",
    "half_page_up",
    "open",
    "next_panel",
    "prev_panel",
    "next_subtab",
    "prev_subtab",
    "toggle_instructions",
    ...TASK_TARGET_ACTIONS,
  ],
  hints: [
    { actions: ["back"], label: "back" },
    { actions: ["prev_subtab", "next_subtab"], label: "part" },
    { actions: ["down", "up"], label: "scroll/move" },
    { actions: ["toggle_instructions"], label: "as the agent gets it" },
    { actions: ["run_now"], label: "run" },
    { actions: ["toggle_pause"], label: "pause" },
    { actions: ["archive"], label: "archive" },
    { actions: ["open_folder"], label: "folder" },
    { actions: ["help"], label: "keys" },
  ],
};
