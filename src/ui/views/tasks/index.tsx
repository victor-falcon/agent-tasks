import type { TabDef } from "../types.ts";
import { Placeholder } from "../placeholder.tsx";
import { TASKS_KEYS } from "./keys.ts";

export const TASKS_TAB: TabDef = {
  title: "Tasks",
  action: "tab_tasks",
  keys: TASKS_KEYS,
  component: (props) => <Placeholder keys={props.keys} what="The Tasks tab" cli="agent-tasks list" />,
};
