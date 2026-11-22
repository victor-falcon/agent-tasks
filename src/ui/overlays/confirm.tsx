import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { type Accessor, onCleanup, Show } from "solid-js";
import type { Confirm as ConfirmData } from "../state.ts";
import { Line } from "../components/line.tsx";
import { useApp } from "../context.ts";

// A question before an expensive action (launching an agent): its title, what
// yes does, and y / n. Enter, Esc and q are the safe answer. Its keys are a
// layer of their own; while it shows, the views' layers are off.

export function Confirm() {
  const app = useApp();
  const off = app.keymap.registerLayer({
    priority: 100,
    enabled: reactiveMatcherFromSignal(() => app.ui.confirm() !== null),
    commands: [
      { name: "confirm.yes", desc: "Yes", run: () => app.ui.answer(true) },
      { name: "confirm.no", desc: "No", run: () => app.ui.answer(false) },
    ],
    bindings: [
      { key: "y", cmd: "confirm.yes" },
      { key: "Y", cmd: "confirm.yes" },
      ...["n", "N", "q", "<Esc>", "<CR>"].map((key) => ({ key, cmd: "confirm.no" })),
    ],
  });
  onCleanup(off);
  return (
    <Show when={app.ui.confirm()}>
      {(confirm: Accessor<ConfirmData>) => (
        <box position="absolute" top={0} left={0} width="100%" height="100%" justifyContent="center" alignItems="center" zIndex={100}>
          <box border borderStyle="rounded" borderColor={app.theme.yellow} backgroundColor={app.theme.bg} paddingLeft={2} paddingRight={2} flexDirection="column" minWidth={40}>
            <Line segments={[{ text: confirm().title, color: "bold" }]} />
            <Line segments={[{ text: confirm().consequence }]} />
            <Line segments={[{ text: "" }]} />
            <Line segments={[{ text: "y", color: "yellow" }, { text: " yes   " }, { text: "n", color: "yellow" }, { text: " no   " }, { text: "(⏎ = no)", color: "dim" }]} />
          </box>
        </box>
      )}
    </Show>
  );
}
