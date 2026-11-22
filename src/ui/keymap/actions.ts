import { ACTIONS as V1_ACTIONS, DEFAULT_KEYS as V1_DEFAULT_KEYS } from "../../tui/keys.ts";
import { NEW_ACTIONS, NEW_DEFAULT_KEYS } from "./new-actions.ts";

// Every action a key can trigger in the new dashboard, with its default keys.
// The names of the old dashboard (src/tui/keys.ts) keep their meaning, so an
// existing tui.toml keeps working; actions the old one did not have get new
// names (new-actions.ts). A view that needs a new action adds it there and
// lists it in its own keys spec (see views/keys.ts).

/** Old names whose description changes with the new views (same meaning: they move and open the same way). */
const REWORDED = {
  next_panel: "Next section",
  prev_panel: "Previous section",
  open: "Open the selected run or task",
  back: "Close the view (back to where you were)",
} as const;

export const ACTIONS = { ...V1_ACTIONS, ...REWORDED, ...NEW_ACTIONS } as const;

export type Action = keyof typeof ACTIONS;

export const DEFAULT_KEYS: Record<Action, readonly string[]> = { ...V1_DEFAULT_KEYS, ...NEW_DEFAULT_KEYS };

/** Actions that move by rows: they take a count (`5j`). */
export const COUNTED_ACTIONS: readonly Action[] = ["down", "up"];
