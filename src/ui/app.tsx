import { Dynamic } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { Footer } from "./components/footer.tsx";
import { Header } from "./components/header.tsx";
import { Line } from "./components/line.tsx";
import { TabBar } from "./components/tab-bar.tsx";
import { useApp } from "./context.ts";
import { Confirm } from "./overlays/confirm.tsx";
import { Help } from "./overlays/help.tsx";
import { Toasts } from "./overlays/toasts.tsx";
import type { Route } from "./state.ts";
import { viewOf } from "./views/registry.tsx";

// The frame: header, tab bar, the current view, footer, and the overlays on
// top. The view is mounted only while it is shown (its keymap layer with it);
// what it must keep (the selection) lives in the UI state.

export function Frame() {
  const app = useApp();
  const route = createMemo(() => app.ui.route(), undefined, { equals: (a, b) => a.view === b.view && JSON.stringify(a.params) === JSON.stringify(b.params) });
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={app.theme.bg}>
      <Header />
      <TabBar />
      <box flexGrow={1} flexDirection="column">
        <Show when={app.store.dash()} fallback={<Line segments={[{ text: app.store.loadError() ? `  agent-tasks: ${app.store.loadError()}` : "  loading…", color: app.store.loadError() ? "red" : "dim" }]} />}>
          <Show when={route()} keyed>
            {(r: Route) => <Dynamic component={viewOf(r).component} params={r.params} keys={viewOf(r).keys} />}
          </Show>
        </Show>
      </box>
      <Footer />
      <Toasts />
      <Confirm />
      <Help />
    </box>
  );
}
