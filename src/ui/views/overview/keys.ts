import { GLOBAL_ACTIONS, GLOBAL_HINTS, LIST_ACTIONS, TARGET_ACTIONS, type ViewKeys } from "../../keymap/spec.ts";

export const OVERVIEW_KEYS: ViewKeys = {
  id: "overview",
  actions: [...GLOBAL_ACTIONS, ...LIST_ACTIONS, ...TARGET_ACTIONS],
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
