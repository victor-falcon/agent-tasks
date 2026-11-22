import type { TabDef } from "../types.ts";
import { Placeholder } from "../placeholder.tsx";
import { RUNS_KEYS } from "./keys.ts";

export const RUNS_TAB: TabDef = {
  title: "Runs",
  action: "tab_runs",
  keys: RUNS_KEYS,
  component: (props) => <Placeholder keys={props.keys} what="The Runs tab" cli="agent-tasks runs" />,
};
