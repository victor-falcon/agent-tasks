import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { onCleanup } from "solid-js";
import { type Handler, useApp } from "../context.ts";
import { ACTIONS, type Action, COUNTED_ACTIONS } from "./actions.ts";
import type { ViewKeys } from "./spec.ts";
import { countedBinding } from "./vim.ts";

// A view's keymap layer: the keys tui.toml gives to each action the view
// lists, bound to the view's handlers (and the global ones), while the view
// is shown and no overlay is open. Views are mounted only while shown, so the
// layer lives as long as the component.

/** The count of `5j`, or 1. */
function countOf(payload: unknown): number {
  const count = (payload as { count?: unknown } | undefined)?.count;
  return typeof count === "number" && count > 0 ? count : 1;
}

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
      run: (ctx) => void all[action]!(countOf(ctx.payload)),
    })),
    bindings: actions.flatMap((action) =>
      app.config.keymap[action].flatMap((b) => {
        const counted = COUNTED_ACTIONS.includes(action) ? countedBinding(b.text) : null;
        return [{ key: b.text, cmd: command(action) }, ...(counted ? [{ key: counted, cmd: command(action) }] : [])];
      }),
    ),
  });
  onCleanup(off);
}
