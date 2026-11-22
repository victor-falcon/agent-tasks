import type { ViewDef } from "../types.ts";
import { Placeholder } from "../placeholder.tsx";
import { RUN_KEYS } from "./keys.ts";

/** One run, opened with `ui.push({ view: "run", params: { ref } })`. */
export const RUN_VIEW: ViewDef = {
  keys: RUN_KEYS,
  component: (props) => <Placeholder keys={props.keys} what={`Run ${props.params.ref}`} cli={`agent-tasks log ${props.params.ref}`} />,
};
