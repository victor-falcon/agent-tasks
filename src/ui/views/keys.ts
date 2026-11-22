import { GLOBAL_ACTIONS, GLOBAL_HINTS, type ViewKeys } from "../keymap/spec.ts";
import { OVERVIEW_KEYS } from "./overview/keys.ts";

// The keys of every view, in one list: what tui.toml is checked against.
// A new view adds its spec here (and its component in views/registry.tsx).

/** A tab that is not built yet: only the global keys. */
export function placeholderKeys(id: string): ViewKeys {
  return { id, actions: GLOBAL_ACTIONS, hints: [{ actions: ["tab_overview"], label: "overview" }, ...GLOBAL_HINTS] };
}

export const TASKS_KEYS = placeholderKeys("tasks");
export const RUNS_KEYS = placeholderKeys("runs");
export const SYSTEM_KEYS = placeholderKeys("system");

/** A detail view that is not built yet (run, task): back and the global keys. */
export function placeholderDetailKeys(id: string): ViewKeys {
  return { id, actions: [...GLOBAL_ACTIONS.filter((a) => a !== "quit" && a !== "dismiss"), "back"], hints: [{ actions: ["back"], label: "back" }, { actions: ["help"], label: "keys" }] };
}

export const RUN_DETAIL_KEYS = placeholderDetailKeys("run");
export const TASK_DETAIL_KEYS = placeholderDetailKeys("task");

export const VIEW_KEYS: readonly ViewKeys[] = [OVERVIEW_KEYS, TASKS_KEYS, RUNS_KEYS, SYSTEM_KEYS, RUN_DETAIL_KEYS, TASK_DETAIL_KEYS];
