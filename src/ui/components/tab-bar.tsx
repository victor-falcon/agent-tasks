import { For } from "solid-js";
import { useApp } from "../context.ts";
import { keyHint } from "../keymap/config.ts";
import { TAB_IDS } from "../state.ts";
import { TABS } from "../views/registry.tsx";
import { Line } from "./line.tsx";

/** The four roots, with the key that jumps to each (as tui.toml has it) and a badge when one needs you. */
export function TabBar() {
  const app = useApp();
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingLeft={1} gap={3}>
      <For each={TAB_IDS}>
        {(id) => {
          const tab = TABS[id];
          const key = keyHint(app.config.keymap, tab.action);
          const active = () => app.ui.tab() === id;
          const badge = () => tab.badge?.(app) ?? null;
          return (
            <box height={1} onMouseDown={() => app.ui.setTab(id)}>
              <Line
                segments={[
                  ...(key ? [{ text: `${key} `, color: "dim" as const }] : []),
                  { text: tab.title, color: active() ? ("cyan" as const) : undefined },
                  ...(badge() ? [{ text: ` ${badge()}`, color: "magenta" as const }] : []),
                ]}
                bold={active()}
              />
            </box>
          );
        }}
      </For>
    </box>
  );
}
