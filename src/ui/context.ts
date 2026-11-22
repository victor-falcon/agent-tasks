import type { CliRenderer } from "@opentui/core";
import { createContext, useContext } from "solid-js";
import type { Actions } from "./actions.ts";
import type { Action } from "./keymap/actions.ts";
import type { TuiConfig } from "./keymap/config.ts";
import type { Count } from "./keymap/count.ts";
import type { AppKeymap } from "./keymap/vim.ts";
import type { Seen } from "./seen.ts";
import type { UiState } from "./state.ts";
import type { Store } from "./store.ts";
import type { Theme } from "./theme.ts";

// Everything a view needs, in one Solid context: the data (store), the UI
// state, the shared actions, the theme and the keymap.

/** Runs an action; `count` is the count typed before the key (`5j`), 1 without one. */
export type Handler = (count: number) => void;

export interface App {
  title: string;
  renderer: CliRenderer;
  store: Store;
  ui: UiState;
  actions: Actions;
  theme: Theme;
  config: TuiConfig;
  keymap: AppKeymap;
  /** The count typed before a motion (`15j`). */
  count: Count;
  seen: Seen;
  /** What works in every view (tabs, help, reload, undo, back, quit). */
  globalHandlers: Partial<Record<Action, Handler>>;
}

export const AppContext = createContext<App>();

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp: outside the dashboard");
  return app;
}
