import type { ActionDefs } from "../../keymap/defs.ts";
import { placeholderDetailKeys, type ViewKeys } from "../../keymap/spec.ts";

/** Actions only this view has (name → description and default keys); none yet. */
export const TASK_ACTIONS = {} as const satisfies ActionDefs;

export const TASK_KEYS: ViewKeys = placeholderDetailKeys("task");
