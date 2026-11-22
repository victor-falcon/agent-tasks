import type { ActionDefs } from "../../keymap/defs.ts";
import { placeholderTabKeys, type ViewKeys } from "../../keymap/spec.ts";

/** Actions only this view has (name → description and default keys); none yet. */
export const TASKS_ACTIONS = {} as const satisfies ActionDefs;

export const TASKS_KEYS: ViewKeys = placeholderTabKeys("tasks");
