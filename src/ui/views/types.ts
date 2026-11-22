import type { Component } from "solid-js";
import type { App } from "../context.ts";
import type { Action } from "../keymap/actions.ts";
import type { ViewKeys } from "../keymap/spec.ts";

// What a view folder (views/<name>/) exports: its component and its keys,
// as a tab (a root) or a detail opened on top of one.

export interface ViewProps {
  params: Record<string, string>;
  /** The view's keys, as registered (the footer and help read the same spec). */
  keys: ViewKeys;
}

export interface ViewDef {
  keys: ViewKeys;
  component: Component<ViewProps>;
}

export interface TabDef extends ViewDef {
  title: string;
  /** The action that jumps to it (its key is shown in the tab bar). */
  action: Action;
  /** Shown after the title when the tab needs you (`!`), or null. */
  badge?: (app: App) => string | null;
}
