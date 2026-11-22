import { For, onCleanup, Show } from "solid-js";
import { fitText } from "../components/cells.ts";
import { Line } from "../components/line.tsx";
import { useApp } from "../context.ts";
import { ACTIONS } from "../keymap/actions.ts";
import { viewOf } from "../views/registry.tsx";

// `?`: every key of the current view, with the tui.toml in use. Any key
// closes it (taken before the keymap sees it).

export function Help() {
  const app = useApp();
  onCleanup(
    app.keymap.intercept(
      "key",
      (ctx) => {
        if (!app.ui.help()) return;
        ctx.consume();
        app.ui.setHelp(false);
      },
      { priority: 50 },
    ),
  );
  const rows = () => {
    const spec = viewOf(app.ui.route()).keys;
    const keys = spec.actions.map((a) => app.config.keymap[a].map((b) => b.text).join(" ") || "(unbound)");
    const width = Math.max(...keys.map((k) => Bun.stringWidth(k)));
    const nameWidth = Math.max(...spec.actions.map((a) => a.length));
    return spec.actions.map((action, i) => ({ keys: fitText(keys[i]!, width), action: fitText(action, nameWidth), desc: ACTIONS[action] }));
  };
  return (
    <Show when={app.ui.help()}>
      <box position="absolute" top={0} left={0} width="100%" height="100%" justifyContent="center" alignItems="center" zIndex={100}>
        <box border borderStyle="rounded" borderColor={app.theme.border} backgroundColor={app.theme.bg} paddingLeft={2} paddingRight={2} flexDirection="column" title=" Keys " titleAlignment="left">
          <Line segments={[{ text: app.config.file ? `from ${app.config.file}` : "defaults; change them in tui.toml in the config folder", color: "dim" }]} />
          <Line segments={[{ text: "" }]} />
          <For each={rows()}>{(row) => <Line segments={[{ text: row.keys, color: "yellow" }, { text: "  " }, { text: row.action, color: "dim" }, { text: "  " }, { text: row.desc }]} />}</For>
          <Line segments={[{ text: "" }]} />
          <Line segments={[{ text: "Ctrl-C always quits. A count before j/k moves that many rows (5j). Any key closes this.", color: "dim" }]} />
        </box>
      </box>
    </Show>
  );
}
