import type { Component } from "solid-js";
import type { App } from "../context.ts";
import type { Action } from "../keymap/actions.ts";
import type { ViewKeys } from "../keymap/spec.ts";
import type { Route, TabId } from "../state.ts";
import { RUN_DETAIL_KEYS, RUNS_KEYS, SYSTEM_KEYS, TASK_DETAIL_KEYS, TASKS_KEYS } from "./keys.ts";
import { OVERVIEW_KEYS } from "./overview/keys.ts";
import { Overview } from "./overview/index.tsx";
import { PlaceholderDetail, PlaceholderTab } from "./placeholder.tsx";

// Every view of the dashboard: the four tabs (roots) and the details a view
// can open on top of them (`ui.push({ view: "run", params: { ref } })`). A
// view is one folder with its component and its keys (views/<name>/); adding
// or replacing one is one line here and one in views/keys.ts.

export interface ViewProps {
  params: Record<string, string>;
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

export const TABS: Record<TabId, TabDef> = {
  overview: { title: "Overview", action: "tab_overview", keys: OVERVIEW_KEYS, component: Overview },
  tasks: { title: "Tasks", action: "tab_tasks", keys: TASKS_KEYS, component: () => <PlaceholderTab keys={TASKS_KEYS} what="Tasks" cli="agent-tasks list" /> },
  runs: { title: "Runs", action: "tab_runs", keys: RUNS_KEYS, component: () => <PlaceholderTab keys={RUNS_KEYS} what="Runs" cli="agent-tasks runs" /> },
  system: {
    title: "System",
    action: "tab_system",
    keys: SYSTEM_KEYS,
    component: () => <PlaceholderTab keys={SYSTEM_KEYS} what="System" cli="agent-tasks doctor" />,
    // Files the data layer could not read are a problem worth a look.
    badge: (app) => ((app.store.dash()?.errors.length ?? 0) > 0 ? "!" : null),
  },
};

export const DETAILS: Record<string, ViewDef> = {
  run: { keys: RUN_DETAIL_KEYS, component: (props) => <PlaceholderDetail keys={RUN_DETAIL_KEYS} what={`Run ${props.params.ref}`} cli={`agent-tasks log ${props.params.ref}`} /> },
  task: { keys: TASK_DETAIL_KEYS, component: (props) => <PlaceholderDetail keys={TASK_DETAIL_KEYS} what={`Task ${props.params.id}`} cli={`agent-tasks show ${props.params.id}`} /> },
};

/** The definition of the view a route shows. */
export function viewOf(route: Route): ViewDef {
  return (TABS as Record<string, ViewDef>)[route.view] ?? DETAILS[route.view] ?? TABS.overview;
}
