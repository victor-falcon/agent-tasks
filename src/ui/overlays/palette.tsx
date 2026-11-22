import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { fitText } from "../components/cells.ts";
import { Line } from "../components/line.tsx";
import { useApp } from "../context.ts";
import { viewOf } from "../views/registry.tsx";
import { listTasks } from "../../store.ts";
import type { Actions, Target } from "../actions.ts";
import type { Store } from "../store.ts";
import { ASKING_ACTIONS, type AskingAction, type PaletteItem, paletteCatalog, rankItems, targetItems } from "./palette-model.ts";

// The command palette (`:` or <C-p>): type to narrow, Up/Down or <C-n>/<C-p>
// to move, Enter to choose, Esc to close. It lists the current view's
// actions, the actions on a task or a run (which ask for it next, in the
// same box: Esc there goes back to the first list), tasks and recent runs
// (palette-model.ts). The input has the keys while it is open; this layer
// takes the few that move and choose, and the views' layers are off.

/** Rows shown at most: the list scrolls with the cursor past that. */
const MAX_ROWS = 14;

/** What each asking action does to the target chosen in the second step: the actions the views' keys run. */
const APPLY: Record<AskingAction, (actions: Actions, target: Target, store: Store) => void> = {
  run_now: (actions, target) => actions.runNow(target),
  toggle_pause: (actions, target) => void actions.togglePause(target),
  retry: (actions, target) => actions.retry(target),
  attach: (actions, target) => void actions.attach(target),
  archive: (actions, target, store) => {
    const taskId = target.kind === "task" ? target.taskId : target.run.task_id;
    // As the Tasks tab says it: a run in progress goes on.
    actions.archive(taskId, store.dash()?.running.some((r) => r.task_id === taskId) ?? false);
  },
};

export function Palette() {
  const app = useApp();
  const { ui, actions, store } = app;
  const dims = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [step, setStep] = createSignal<AskingAction | null>(null);
  const [cursor, setCursor] = createSignal(0);

  // Each opening starts afresh.
  createEffect(
    on(ui.palette, (open) => {
      if (!open) return;
      setQuery("");
      setStep(null);
      setCursor(0);
    }),
  );

  /** The saved tasks, read when the palette opens (and on a reload while it is open). */
  const tasks = createMemo(() => {
    store.version();
    const ctx = store.ctx();
    return ui.palette() && ctx ? listTasks(ctx.paths).items : [];
  });
  const items = createMemo((): PaletteItem[] => {
    if (!ui.palette()) return [];
    const route = ui.route();
    const asking = step();
    if (asking) return targetItems(asking, store.dash(), tasks(), { taskId: route.view === "task" ? route.params.id : undefined, ref: route.view === "run" ? route.params.ref : undefined });
    return paletteCatalog({
      viewId: viewOf(route).keys.id,
      commands: app.keymap.getCommands({ visibility: "registered" }).map((c) => c.name),
      keymap: app.config.keymap,
      dash: store.dash(),
      tasks: tasks(),
    });
  });
  const ranked = createMemo(() => rankItems(items(), query()));
  const rows = () => Math.max(1, Math.min(MAX_ROWS, dims().height - 10));
  /** The first row shown, so the cursor stays in view. */
  const top = () => Math.max(0, Math.min(cursor() - rows() + 1, ranked().length - rows()));

  const move = (by: number) => {
    const n = ranked().length;
    if (n > 0) setCursor((cursor() + by + n) % n);
  };
  const close = () => ui.setPalette(false);
  const choose = (item: PaletteItem | undefined = ranked()[cursor()]) => {
    if (!item) return;
    const pick = item.pick;
    if (pick.type === "ask") {
      setStep(pick.action);
      setQuery("");
      setCursor(0);
      return;
    }
    // Closed first: the view's layer is on again for the command, and a confirm can open.
    close();
    if (pick.type === "command") app.keymap.runCommand(pick.command);
    else if (pick.type === "open_task") ui.push({ view: "task", params: { id: pick.id } });
    else if (pick.type === "open_run") ui.push({ view: "run", params: { ref: pick.ref } });
    else APPLY[pick.action](actions, pick.target, store);
  };
  const escape = () => {
    if (step() === null) return close();
    setStep(null);
    setQuery("");
    setCursor(0);
  };

  const off = app.keymap.registerLayer({
    priority: 95,
    enabled: reactiveMatcherFromSignal(() => ui.palette()),
    commands: [
      { name: "palette.down", desc: "Next item", run: () => move(1) },
      { name: "palette.up", desc: "Previous item", run: () => move(-1) },
      { name: "palette.choose", desc: "Choose the item", run: () => choose() },
      { name: "palette.escape", desc: "Back, or close the palette", run: escape },
    ],
    bindings: [
      { key: "<Down>", cmd: "palette.down" },
      { key: "<C-n>", cmd: "palette.down" },
      { key: "<Up>", cmd: "palette.up" },
      { key: "<C-p>", cmd: "palette.up" },
      { key: "<CR>", cmd: "palette.choose" },
      { key: "<Esc>", cmd: "palette.escape" },
    ],
  });
  onCleanup(off);

  const width = () => Math.max(30, Math.min(100, dims().width - 4));
  /** The text of one row, cut to the box: title, dim detail, keys on the right. */
  const rowSegments = (item: PaletteItem) => {
    const inner = width() - 4;
    const keys = item.keys ? ` ${item.keys}` : "";
    const room = Math.max(0, inner - Bun.stringWidth(keys));
    const title = Bun.stringWidth(item.title) >= room ? fitText(item.title, room) : item.title;
    const detail = fitText(item.detail ? `  ${item.detail}` : "", Math.max(0, room - Bun.stringWidth(title)));
    return [{ text: title }, { text: detail, color: "dim" as const }, { text: keys, color: "yellow" as const }];
  };
  const prompt = () => {
    const asking = step();
    return asking ? ASKING_ACTIONS[asking].prompt : "Actions, tasks and runs";
  };

  return (
    <Show when={ui.palette()}>
      <box position="absolute" top={2} left={0} width="100%" alignItems="center" zIndex={100}>
        <box border borderStyle="rounded" borderColor={app.theme.cyan} backgroundColor={app.theme.bg} paddingLeft={1} paddingRight={1} flexDirection="column" width={width()} title={` ${prompt()} `} titleAlignment="left">
          <box flexDirection="row" height={1}>
            <Line segments={[{ text: step() ? "› " : ": ", color: "yellow" }]} />
            <input
              flexGrow={1}
              value={query()}
              focused
              onInput={(value: string) => {
                setQuery(value);
                setCursor(0);
              }}
              textColor={app.theme.fg}
              backgroundColor={app.theme.bg}
              focusedBackgroundColor={app.theme.bg}
              focusedTextColor={app.theme.fg}
              cursorColor={app.theme.fg}
            />
          </box>
          <Show when={ranked().length > 0} fallback={<Line segments={[{ text: step() ? "nothing to choose here" : "no match", color: "dim" }]} />}>
            <For each={ranked().slice(top(), top() + rows())}>
              {(item, i) => (
                <box height={1} onMouseDown={() => choose(item)}>
                  <Line segments={rowSegments(item)} inverse={top() + i() === cursor()} />
                </box>
              )}
            </For>
          </Show>
          <Line segments={[{ text: `${ranked().length > rows() ? `${cursor() + 1}/${ranked().length} · ` : ""}↑↓ move · ⏎ choose · <Esc> ${step() ? "back" : "close"}`, color: "dim" }]} />
        </box>
      </box>
    </Show>
  );
}
