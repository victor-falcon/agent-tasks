import type { ViewKeys } from "../keymap/spec.ts";
import { OVERVIEW_KEYS } from "./overview/keys.ts";
import { RUN_KEYS } from "./run/keys.ts";
import { RUNS_KEYS } from "./runs/keys.ts";
import { SYSTEM_KEYS } from "./system/keys.ts";
import { TASK_KEYS } from "./task/keys.ts";
import { TASKS_KEYS } from "./tasks/keys.ts";

// The keys of every view, in one list: what tui.toml is checked against.
// Pure data (registry.tsx has the components), so `config check` reads it
// without loading the UI. Each view changes its spec in its own keys.ts.

export const VIEW_KEYS: readonly ViewKeys[] = [OVERVIEW_KEYS, TASKS_KEYS, RUNS_KEYS, SYSTEM_KEYS, RUN_KEYS, TASK_KEYS];
