import { OVERVIEW_ACTIONS } from "../views/overview/keys.ts";
import { RUN_ACTIONS } from "../views/run/keys.ts";
import { RUNS_ACTIONS } from "../views/runs/keys.ts";
import { SYSTEM_ACTIONS } from "../views/system/keys.ts";
import { TASK_ACTIONS } from "../views/task/keys.ts";
import { TASKS_ACTIONS } from "../views/tasks/keys.ts";
import type { ActionDefs } from "./defs.ts";

// Actions only the new dashboard has, with their default keys: the global
// ones here, and each view's own in its keys.ts (a view adds an action there,
// not here). The old dashboard's tui.toml loader asks `isNewAction` to skip
// these names, so one tui.toml serves both.

const GLOBAL_NEW_ACTIONS = {
  next_tab: { desc: "Next tab", keys: ["gt"] },
  prev_tab: { desc: "Previous tab", keys: ["gT"] },
  tab_overview: { desc: "Go to the Overview tab", keys: ["1"] },
  tab_tasks: { desc: "Go to the Tasks tab", keys: ["2"] },
  tab_runs: { desc: "Go to the Runs tab", keys: ["3"] },
  tab_system: { desc: "Go to the System tab", keys: ["4"] },
  undo: { desc: "Undo the last pause or resume (while its toast shows)", keys: ["u"] },
  dismiss: { desc: "Dismiss the messages at the bottom right", keys: ["<Esc>"] },
  palette: { desc: "Open the command palette: actions, tasks and runs", keys: [":", "<C-p>"] },
} as const satisfies ActionDefs;

/** The `/` filter bar (components/filter-bar.tsx), for any list view. `cycle_filter` and `copy` are the Runs view's generic actions (views/runs/keys.ts). */
const LIST_NEW_ACTIONS = {
  filter: { desc: "Filter the list by text (Enter keeps it, Esc clears it)", keys: ["/"] },
} as const satisfies ActionDefs;

export const NEW_ACTION_DEFS = { ...GLOBAL_NEW_ACTIONS, ...LIST_NEW_ACTIONS, ...OVERVIEW_ACTIONS, ...TASKS_ACTIONS, ...RUNS_ACTIONS, ...SYSTEM_ACTIONS, ...RUN_ACTIONS, ...TASK_ACTIONS } as const satisfies ActionDefs;

export type NewAction = keyof typeof NEW_ACTION_DEFS;

const defs = Object.entries(NEW_ACTION_DEFS as ActionDefs);

export const NEW_ACTIONS = Object.fromEntries(defs.map(([name, def]) => [name, def.desc])) as Record<NewAction, string>;

export const NEW_DEFAULT_KEYS = Object.fromEntries(defs.map(([name, def]) => [name, def.keys])) as Record<NewAction, readonly string[]>;

/** Whether `name` is an action of the new dashboard only (the old one ignores it in tui.toml). */
export function isNewAction(name: string): boolean {
  return Object.hasOwn(NEW_ACTION_DEFS, name);
}
