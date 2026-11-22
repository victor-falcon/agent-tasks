// Actions only the new dashboard has, with their default keys. Kept apart
// (no imports) so the old dashboard's tui.toml loader can skip these names
// without a circular import.

export const NEW_ACTIONS = {
  next_tab: "Next tab",
  prev_tab: "Previous tab",
  tab_overview: "Go to the Overview tab",
  tab_tasks: "Go to the Tasks tab",
  tab_runs: "Go to the Runs tab",
  tab_system: "Go to the System tab",
  undo: "Undo the last pause or resume (while its toast shows)",
  dismiss: "Dismiss the messages at the bottom right",
} as const;

export const NEW_DEFAULT_KEYS: Record<keyof typeof NEW_ACTIONS, readonly string[]> = {
  next_tab: ["gt"],
  prev_tab: ["gT"],
  tab_overview: ["1"],
  tab_tasks: ["2"],
  tab_runs: ["3"],
  tab_system: ["4"],
  undo: ["u"],
  dismiss: ["<Esc>"],
};

/** Whether `name` is an action of the new dashboard only (the old one ignores it in tui.toml). */
export function isNewAction(name: string): boolean {
  return Object.hasOwn(NEW_ACTIONS, name);
}
