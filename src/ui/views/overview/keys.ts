import type { ActionDefs } from "../../keymap/defs.ts";
import { GLOBAL_ACTIONS, GLOBAL_HINTS, LIST_ACTIONS, TARGET_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

/** Actions only this view has (name → description and default keys). */
export const OVERVIEW_ACTIONS = {
  dismiss_attention: { desc: "Dismiss the selected failure from Needs attention (seen, without opening it)", keys: ["x"] },
} as const satisfies ActionDefs;

export const OVERVIEW_KEYS: ViewKeys = {
  id: "overview",
  actions: [...GLOBAL_ACTIONS, ...LIST_ACTIONS, ...TARGET_ACTIONS, "dismiss_attention"],
  hints: [
    { actions: ["down", "up"], label: "move" },
    { actions: ["next_panel"], label: "section" },
    { actions: ["open"], label: "open" },
    { actions: ["attach"], label: "attach" },
    { actions: ["retry"], label: "retry" },
    { actions: ["run_now"], label: "run" },
    { actions: ["toggle_pause"], label: "pause" },
    ...GLOBAL_HINTS,
  ],
};
