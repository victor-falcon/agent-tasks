import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { onCleanup } from "solid-js";
import { type Handler, useApp } from "../context.ts";
import { ACTIONS, type Action } from "./actions.ts";
import type { ViewKeys } from "./spec.ts";

// A view's keymap layer: the keys tui.toml gives to each action the view
// lists, bound to the view's handlers (and the global ones), while the view
// is shown and no overlay is open. Views are mounted only while shown, so the
// layer lives as long as the component. The count typed before a motion
// (`15j`) comes from count.ts, not from the binding.

export function useViewKeys(spec: ViewKeys, handlers: Partial<Record<Action, Handler>>): void {
  const app = useApp();
  const all: Partial<Record<Action, Handler>> = { ...app.globalHandlers, ...handlers };
  const actions = spec.actions.filter((a) => all[a] !== undefined);
  const command = (action: Action) => `${spec.id}.${action}`;
  const off = app.keymap.registerLayer({
    enabled: reactiveMatcherFromSignal(() => !app.ui.modal()),
    commands: actions.map((action) => ({
      name: command(action),
      desc: ACTIONS[action],
      run: () => void all[action]!(app.count.take()),
    })),
    bindings: actions.flatMap((action) => app.config.keymap[action].map((b) => ({ key: b.text, cmd: command(action) }))),
  });
  onCleanup(off);
}
