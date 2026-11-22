import type { TabDef } from "../types.ts";
import { Placeholder } from "../placeholder.tsx";
import { SYSTEM_KEYS } from "./keys.ts";

export const SYSTEM_TAB: TabDef = {
  title: "System",
  action: "tab_system",
  keys: SYSTEM_KEYS,
  component: (props) => <Placeholder keys={props.keys} what="The System tab" cli="agent-tasks doctor" />,
  // Files the data layer could not read are a problem worth a look.
  badge: (app) => ((app.store.dash()?.errors.length ?? 0) > 0 ? "!" : null),
};
