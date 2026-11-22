import type { ViewDef } from "../types.ts";
import { Placeholder } from "../placeholder.tsx";
import { TASK_KEYS } from "./keys.ts";

/** One task, opened with `ui.push({ view: "task", params: { id } })`. */
export const TASK_VIEW: ViewDef = {
  keys: TASK_KEYS,
  component: (props) => <Placeholder keys={props.keys} what={`Task ${props.params.id}`} cli={`agent-tasks show ${props.params.id}`} />,
};
