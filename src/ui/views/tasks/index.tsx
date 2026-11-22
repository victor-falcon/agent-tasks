import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Index, Show } from "solid-js";
import { displayTimezone, showMachineColumn } from "../../../task-info.ts";
import { FilterBar, useFilter } from "../../components/filter-bar.tsx";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { SectionList } from "../../components/section-list.tsx";
import type { Segment } from "../../components/cells.ts";
import { useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { TabDef, ViewProps } from "../types.ts";
import { taskHandlers } from "./handlers.ts";
import { TASKS_KEYS } from "./keys.ts";
import { cycle, filterTasks, loadTaskItems, machinesOf, nextMachine, SORT_LABELS, SORTS, type Sort, STATE_FILTERS, type StateFilter, sortTasks, type TaskItem, idOfKey, taskSections } from "./model.ts";
import { TaskPreview } from "./preview.tsx";

// Every task as a table (archived ones in their own section), with the
// selection's preview on the right on a wide terminal. `/` filters by text,
// `f` by state, `m` by machine, `s` changes the order; all of it is kept in
// the UI state, so coming back from a task finds the list as it was.

/** From this width on, the list shares the screen with the preview. */
export const PREVIEW_MIN_WIDTH = 120;
/** Under this width the table leaves out the title and the folder. */
export const NARROW_WIDTH = 80;

function Tasks(props: ViewProps) {
  const app = useApp();
  const { store, ui } = app;
  const dims = useTerminalDimensions();
  const filter = useFilter("tasks");
  const [state, setState] = ui.viewState<StateFilter>("tasks:state", "all");
  const [machine, setMachine] = ui.viewState<string | null>("tasks:machine", null);
  const [sort, setSort] = ui.viewState<Sort>("tasks:sort", "next");

  // Every task (and its runs), read again on each reload, not on each clock tick.
  const items = createMemo((): TaskItem[] => {
    store.version();
    const ctx = store.ctx();
    return ctx ? loadTaskItems(ctx).items : [];
  });
  const shown = createMemo(() => sortTasks(filterTasks(items(), { state: state(), machine: machine(), query: filter.query() }), sort()));
  const showPreview = () => dims().width >= PREVIEW_MIN_WIDTH;
  const listWidth = () => (showPreview() ? Math.floor(dims().width * 0.55) : dims().width);
  const sections = createMemo(() => {
    const ctx = store.ctx();
    if (!ctx) return [];
    const input = { now: store.now(), timezone: displayTimezone(ctx), showMachine: showMachineColumn(ctx.config.config, items().map((i) => i.task.machine)), showTitle: !showPreview() && listWidth() >= NARROW_WIDTH, showFolder: listWidth() >= NARROW_WIDTH };
    return taskSections(shown(), state(), input, filter.query() !== "" || machine() !== null);
  });
  const nav = useListNavigation("tasks", sections);
  const selected = () => {
    const key = nav.selected();
    if (!key) return null;
    const id = idOfKey(key);
    return shown().find((i) => i.task.id === id) ?? null;
  };

  /** A machine filter only helps with tasks on more than one machine (a stale one stays visible, to be cleared). */
  const machineFilterUseful = () => machinesOf(items()).length > 1 || machine() !== null;
  const cycleMachine = () => {
    if (!machineFilterUseful()) return void ui.toast(`every task runs on ${machinesOf(items())[0] ?? "this machine"}: nothing to filter`);
    setMachine(nextMachine(items(), machine()));
  };

  const open = (key = nav.selected()) => key && ui.push({ view: "task", params: { id: idOfKey(key) } });

  useViewKeys(props.keys, {
    ...nav.handlers,
    ...taskHandlers(app, selected),
    open: () => open(),
    filter: () => filter.open(),
    cycle_filter: () => setState(cycle(STATE_FILTERS, state())),
    filter_machine: cycleMachine,
    sort: () => setSort(cycle(SORTS, sort())),
    // Esc dismisses the messages first, then a kept filter.
    dismiss: () => (ui.toasts().length > 0 ? ui.dismiss() : filter.clear()),
  });

  /** The filters in use, one click each to change them (the machine one only when it can change something). */
  const chips = (): { segments: Segment[]; onClick(): void }[] => {
    const key = (action: "cycle_filter" | "filter_machine" | "sort") => keyHint(app.config.keymap, action) ?? "";
    const chip = (k: string, label: string, value: string, changed: boolean): Segment[] => [
      { text: `${k} `, color: "dim" },
      { text: `${label} `, color: "dim" },
      { text: value, color: changed ? "yellow" : undefined },
    ];
    return [
      { segments: chip(key("cycle_filter"), "state", state(), state() !== "all"), onClick: () => setState(cycle(STATE_FILTERS, state())) },
      ...(machineFilterUseful() ? [{ segments: chip(key("filter_machine"), "machine", machine() ?? "all", machine() !== null), onClick: cycleMachine }] : []),
      { segments: chip(key("sort"), "sort", SORT_LABELS[sort()], sort() !== "next"), onClick: () => setSort(cycle(SORTS, sort())) },
    ];
  };

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" width={listWidth()} flexShrink={0}>
        <box flexDirection="row" height={1} flexShrink={0} paddingLeft={2} gap={3}>
          {/* Index: a few chips whose text changes; their boxes stay. */}
          <Index each={chips()}>
            {(c) => (
              <box height={1} onMouseDown={() => c().onClick()}>
                <Line segments={c().segments} />
              </box>
            )}
          </Index>
          <Line segments={[{ text: `${shown().length} of ${items().length}`, color: "dim" }]} />
        </box>
        <FilterBar filter={filter} />
        <SectionList sections={sections()} selected={nav.selected()} width={listWidth()} onSelect={nav.select} onOpen={open} />
      </box>
      <Show when={showPreview()}>
        <TaskPreview item={selected()} width={dims().width - listWidth()} />
      </Show>
    </box>
  );
}

export const TASKS_TAB: TabDef = { title: "Tasks", action: "tab_tasks", keys: TASKS_KEYS, component: Tasks };
