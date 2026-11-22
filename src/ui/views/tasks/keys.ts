import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, GLOBAL_HINTS, LIST_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

/** Actions only the task views have (the Tasks tab and the Task detail): name → description and default keys. */
export const TASKS_ACTIONS = {
  filter_machine: { desc: "Show only the tasks of one machine (cycles)", keys: ["m"] },
  sort: { desc: "Sort the tasks: next run, id, last result (cycles)", keys: ["s"] },
  archive: { desc: "Archive the task (agent-tasks rm; its runs are kept)", keys: ["D"] },
  open_folder: { desc: "Open a shell in the task's folder (exit it to come back)", keys: ["o"] },
} as const satisfies ActionDefs;

/** What acts on the selected task, in the list and in its detail. */
export const TASK_TARGET_ACTIONS = ["run_now", "toggle_pause", "archive", "open_folder", "copy"] as const;

export const TASKS_KEYS: ViewKeys = {
  id: "tasks",
  actions: [...GLOBAL_ACTIONS, ...LIST_ACTIONS, ...TASK_TARGET_ACTIONS, "filter", "cycle_filter", "filter_machine", "sort"],
  hints: [
    { actions: ["down", "up"], label: "move" },
    { actions: ["open"], label: "open" },
    { actions: ["filter"], label: "filter" },
    { actions: ["cycle_filter"], label: "state" },
    { actions: ["filter_machine"], label: "machine" },
    { actions: ["sort"], label: "sort" },
    { actions: ["run_now"], label: "run" },
    { actions: ["toggle_pause"], label: "pause" },
    { actions: ["archive"], label: "archive" },
    ...GLOBAL_HINTS,
  ],
};
