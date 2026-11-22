import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { displayTimezone, showMachineColumn } from "../../../task-info.ts";
import { FilterBar, useFilter } from "../../components/filter-bar.tsx";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { SectionList } from "../../components/section-list.tsx";
import type { Segment } from "../../components/cells.ts";
import { type App, useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { TabDef, ViewProps } from "../types.ts";
import { TASKS_KEYS } from "./keys.ts";
import { cycle, filterTasks, loadTaskItems, nextMachine, SORT_LABELS, SORTS, type Sort, STATE_FILTERS, type StateFilter, sortTasks, type TaskItem, taskIdOf, taskSections } from "./model.ts";
import { TaskPreview } from "./preview.tsx";

// Every task as a table (archived ones in their own section), with the
// selection's preview on the right on a wide terminal. `/` filters by text,
// `f` by state, `m` by machine, `s` changes the order; all of it is kept in
// the UI state, so coming back from a task finds the list as it was.

/** From this width on, the list shares the screen with the preview. */
export const PREVIEW_MIN_WIDTH = 120;
/** Under this width the table leaves out the title and the folder. */
export const NARROW_WIDTH = 80;

/** Every task, read again on each reload (not on each clock tick). */
export function useTaskItems(app: App) {
  return createMemo((): TaskItem[] => {
    app.store.version();
    const ctx = app.store.ctx();
    return ctx ? loadTaskItems(ctx).items : [];
  });
}

/**
 * The task actions on one task, the same in the list and in its detail:
 * archived tasks are not scheduled any more, so they can only be read.
 */
export function taskHandlers(app: App, item: () => TaskItem | null) {
  const { actions } = app;
  const live = (what: string, run: (item: TaskItem) => void) => () => {
    const it = item();
    if (!it) return;
    if (it.archived) return actions.error(`${it.task.id} is archived: it can't be ${what}; restore it first (see agent-tasks show ${it.task.id})`);
    run(it);
  };
  return {
    run_now: live("run", (it) => actions.runNow({ kind: "task", taskId: it.task.id })),
    toggle_pause: live("paused or resumed", (it) => void actions.togglePause({ kind: "task", taskId: it.task.id })),
    archive: live("archived again", (it) => actions.archive(it.task.id)),
    open_folder: () => {
      const it = item();
      if (it) void actions.openFolder(it.task);
    },
    copy: () => {
      const it = item();
      if (it) actions.copy(it.task.id, "task id");
    },
  };
}

function Tasks(props: ViewProps) {
  const app = useApp();
  const { store, ui } = app;
  const dims = useTerminalDimensions();
  const filter = useFilter("tasks");
  const [state, setState] = ui.viewState<StateFilter>("tasks:state", "all");
  const [machine, setMachine] = ui.viewState<string | null>("tasks:machine", null);
  const [sort, setSort] = ui.viewState<Sort>("tasks:sort", "next");

  const items = useTaskItems(app);
  const shown = createMemo(() => sortTasks(filterTasks(items(), { state: state(), machine: machine(), matches: filter.matches }), sort()));
  const showPreview = () => dims().width >= PREVIEW_MIN_WIDTH;
  const listWidth = () => (showPreview() ? Math.floor(dims().width * 0.55) : dims().width);
  const sections = createMemo(() => {
    const ctx = store.ctx();
    if (!ctx) return [];
    const input = { now: store.now(), timezone: displayTimezone(ctx), showMachine: showMachineColumn(ctx.config.config, items().map((i) => i.task.machine)), showTitle: !showPreview() && listWidth() >= NARROW_WIDTH, showFolder: listWidth() >= NARROW_WIDTH };
    return taskSections(shown(), state(), input);
  });
  const nav = useListNavigation("tasks", sections);
  const selected = () => {
    const key = nav.selected();
    if (!key) return null;
    const id = taskIdOf(key);
    return shown().find((i) => i.task.id === id) ?? null;
  };

  const open = (key = nav.selected()) => key && ui.push({ view: "task", params: { id: taskIdOf(key) } });

  useViewKeys(props.keys, {
    ...nav.handlers,
    ...taskHandlers(app, selected),
    open: () => open(),
    filter: () => filter.open(),
    cycle_filter: () => setState(cycle(STATE_FILTERS, state())),
    filter_machine: () => setMachine(nextMachine(items(), machine())),
    sort: () => setSort(cycle(SORTS, sort())),
    // Esc dismisses the messages first, then a kept filter.
    dismiss: () => (ui.toasts().length > 0 ? ui.dismiss() : filter.clear()),
  });

  /** The filters in use, one click each to change them. */
  const chips = (): { segments: Segment[]; onClick(): void }[] => {
    const key = (action: "cycle_filter" | "filter_machine" | "sort") => keyHint(app.config.keymap, action) ?? "";
    const chip = (k: string, label: string, value: string, changed: boolean): Segment[] => [
      { text: `${k} `, color: "dim" },
      { text: `${label} `, color: "dim" },
      { text: value, color: changed ? "yellow" : undefined },
    ];
    return [
      { segments: chip(key("cycle_filter"), "state", state(), state() !== "all"), onClick: () => setState(cycle(STATE_FILTERS, state())) },
      { segments: chip(key("filter_machine"), "machine", machine() ?? "all", machine() !== null), onClick: () => setMachine(nextMachine(items(), machine())) },
      { segments: chip(key("sort"), "sort", SORT_LABELS[sort()], sort() !== "next"), onClick: () => setSort(cycle(SORTS, sort())) },
    ];
  };

  return (
    <box flexDirection="row" flexGrow={1}>
      <box flexDirection="column" width={listWidth()} flexShrink={0}>
        <box flexDirection="row" height={1} flexShrink={0} paddingLeft={2} gap={3}>
          {chips().map((c) => (
            <box height={1} onMouseDown={c.onClick}>
              <Line segments={c.segments} />
            </box>
          ))}
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
