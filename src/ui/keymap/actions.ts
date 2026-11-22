import { NEW_ACTIONS, NEW_DEFAULT_KEYS } from "./new-actions.ts";

// Every action a key can trigger, with its default keys. The first
// dashboard's names (below) keep their meaning, so a tui.toml written for it
// keeps working; actions it did not have are in new-actions.ts. A view that
// needs a new action adds it there and lists it in its own keys spec (see
// views/keys.ts).

/** The first dashboard's actions: their names are part of tui.toml. */
const FIRST_ACTIONS = {
  down: "Move down / scroll down",
  up: "Move up / scroll up",
  first: "Go to the first row / the top",
  last: "Go to the last row / the bottom",
  half_page_down: "Half a page down",
  half_page_up: "Half a page up",
  next_panel: "Next section",
  prev_panel: "Previous section",
  open: "Open the selected run or task",
  back: "Close the view (back to where you were)",
  next_section: "Next section of the run",
  prev_section: "Previous section of the run",
  toggle_section: "Fold or open the selected section of the run",
  open_sections: "Open every section of the run",
  fold_sections: "Fold every section of the run",
  attach: "Attach to the run's session",
  retry: "Retry the run (failed, timed out or missed)",
  run_now: "Run the task now",
  toggle_pause: "Pause or resume the task",
  refresh: "Reload everything now",
  help: "Show the keys",
  quit: "Quit",
} as const;

const FIRST_DEFAULT_KEYS: Record<keyof typeof FIRST_ACTIONS, readonly string[]> = {
  down: ["j", "<Down>"],
  up: ["k", "<Up>"],
  first: ["gg", "<Home>"],
  last: ["G", "<End>"],
  half_page_down: ["<C-d>", "<PageDown>"],
  half_page_up: ["<C-u>", "<PageUp>"],
  next_panel: ["<Tab>", "<C-w>j"],
  prev_panel: ["<S-Tab>", "<C-w>k"],
  open: ["<CR>", "l"],
  back: ["<Esc>", "h", "q"],
  next_section: ["}"],
  prev_section: ["{"],
  toggle_section: ["<CR>", "<Space>", "za"],
  open_sections: ["zR"],
  fold_sections: ["zM"],
  attach: ["a"],
  retry: ["r"],
  run_now: ["R"],
  toggle_pause: ["p"],
  refresh: ["<C-l>"],
  help: ["?"],
  quit: ["q"],
};

export const ACTIONS = { ...FIRST_ACTIONS, ...NEW_ACTIONS } as const;

export type Action = keyof typeof ACTIONS;

export const DEFAULT_KEYS: Record<Action, readonly string[]> = { ...FIRST_DEFAULT_KEYS, ...NEW_DEFAULT_KEYS };

/** Actions that move by rows: they take a count (`5j`). */
export const COUNTED_ACTIONS: readonly Action[] = ["down", "up"];
