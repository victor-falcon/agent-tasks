import { Line } from "../components/line.tsx";
import { useViewKeys } from "../keymap/layer.ts";
import type { Route, TabId } from "../state.ts";
import { OVERVIEW_TAB } from "./overview/index.tsx";
import { RUN_VIEW } from "./run/index.tsx";
import { RUNS_TAB } from "./runs/index.tsx";
import { SYSTEM_TAB } from "./system/index.tsx";
import { TASK_VIEW } from "./task/index.tsx";
import { TASKS_TAB } from "./tasks/index.tsx";
import type { TabDef, ViewDef } from "./types.ts";

// Every view of the dashboard: the four tabs (roots) and the details a view
// can open on top of them (`ui.push({ view: "run", params: { ref } })`). Each
// view is one folder (views/<name>/: index.tsx exports its definition,
// keys.ts its keys and actions), so building or replacing one stays inside
// its folder.

export type { TabDef, ViewDef, ViewProps } from "./types.ts";

export const TABS: Record<TabId, TabDef> = { overview: OVERVIEW_TAB, tasks: TASKS_TAB, runs: RUNS_TAB, system: SYSTEM_TAB };

export const DETAILS: Record<string, ViewDef> = { run: RUN_VIEW, task: TASK_VIEW };

/** Shown for a route nobody registered: a typo in `ui.push` shows up instead of falling back silently. */
const UNKNOWN: ViewDef = {
  keys: RUN_VIEW.keys,
  component: (props) => {
    useViewKeys(props.keys, {});
    return (
      <box flexGrow={1} paddingLeft={2} paddingTop={1}>
        <Line segments={[{ text: `No view for ${JSON.stringify(props.params)}: this is a bug.`, color: "bold" }]} />
      </box>
    );
  },
};

/** The definition of the view a route shows. */
export function viewOf(route: Route): ViewDef {
  return (TABS as Record<string, ViewDef>)[route.view] ?? DETAILS[route.view] ?? UNKNOWN;
}
