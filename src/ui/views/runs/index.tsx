import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { type Accessor, batch, createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import type { Target } from "../../actions.ts";
import { FilterBar, useFilter } from "../../components/filter-bar.tsx";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { PREVIEW_MIN_WIDTH, RunPreview } from "../../components/run-preview.tsx";
import { buildRunPreview, type RunPreviewData } from "../../components/run-preview-model.ts";
import { type ListSection, SectionList } from "../../components/section-list.tsx";
import { type App, useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { TabDef, ViewProps } from "../types.ts";
import { RUNS_KEYS } from "./keys.ts";
import {
  chipSegments,
  DEFAULT_FILTER,
  isFiltered,
  loadRuns,
  needsMore,
  nextSince,
  nextStatus,
  PAGE_SIZE,
  type RunCache,
  type RunsFilter,
  type RunsPage,
  refOf,
  rowKey,
  runCells,
} from "./model.ts";

// The whole history, newest first, a page at a time: the next page is read
// when the cursor, or the wheel, gets near the end of what is loaded. Above
// the list, the filters as chips (`f` status, `S` since) and the `/` text
// filter (the shared filter bar, over task id and summary or reason); on a
// wide terminal, the selected run's preview on the right. The selection
// follows the run's ref across reloads and pages.

/** The filters the chips set; the `/` text is the filter bar's (kept in the UI state). */
type ChipFilter = Omit<RunsFilter, "text">;

/** What the tab keeps while a detail is open on top of it (the component is mounted again on the way back). */
interface Kept {
  filter: ChipFilter;
  limit: number;
  cache: RunCache;
}

const kept = new WeakMap<App, Kept>();

function Runs(props: ViewProps) {
  const app = useApp();
  const { store, ui, actions, renderer } = app;
  const dims = useTerminalDimensions();

  const initial = kept.get(app) ?? { filter: DEFAULT_FILTER, limit: PAGE_SIZE, cache: new Map() };
  const cache = initial.cache;
  const [chips, setChips] = createSignal(initial.filter);
  const text = useFilter("runs");
  const filter = createMemo((): RunsFilter => ({ ...chips(), text: text.query() }));
  const [limit, setLimit] = createSignal(initial.limit);
  createEffect(() => kept.set(app, { filter: chips(), limit: limit(), cache }));

  // Read again on every reload (store.version) and when the filters or the
  // page count change; not on every clock tick.
  const page = createMemo((): RunsPage => {
    store.version();
    const ctx = store.ctx();
    return ctx ? loadRuns(ctx, filter(), limit(), cache) : { runs: [], more: false };
  });
  const loadMore = () => setLimit((l) => l + PAGE_SIZE);

  const emptyText = () => {
    if (!isFiltered(filter())) return "no runs yet";
    const keys = [keyHint(app.config.keymap, "cycle_filter"), keyHint(app.config.keymap, "cycle_since"), ...(filter().text !== "" ? ["<Esc>"] : [])].filter((k) => k !== null);
    return `no runs match these filters${keys.length > 0 ? ` (${keys.join(" / ")} to change them)` : ""}`;
  };

  const sections = createMemo((): ListSection[] => {
    const ctx = store.ctx();
    if (!ctx) return [];
    const tz = displayTimezone(ctx);
    const now = store.now();
    return [{ id: "runs", title: "History", rows: page().runs.map((r) => ({ key: rowKey(r.ref), cells: runCells(r, tz, now) })), empty: emptyText() }];
  });
  const nav = useListNavigation("runs", sections);

  const selectedRun = createMemo(() => {
    const key = nav.selected();
    if (!key) return null;
    const ref = refOf(key);
    return page().runs.find((r) => r.ref === ref) ?? null;
  });
  const target = (): Target | null => {
    const run = selectedRun();
    return run ? { kind: "run", run } : null;
  };

  // The cursor near the end of what is loaded: read the next page.
  createEffect(() => {
    const p = page();
    const ref = selectedRun()?.ref;
    if (ref !== undefined && needsMore(p.runs.findIndex((r) => r.ref === ref), p)) loadMore();
  });

  // The wheel scrolls without moving the cursor: when it shows the last
  // rows, read the next page too. (The list is the box's only child; the box
  // is a row so the list takes its height and scrolls inside it.)
  let listBox: BoxRenderable | undefined;
  const onWheel = () => {
    const scroll = listBox?.getChildren()[0] as ScrollBoxRenderable | undefined;
    if (!scroll) return;
    // Rows from the top of the list to the bottom of the view, less the section title.
    const lastInView = scroll.scrollTop + scroll.height - 2;
    if (needsMore(lastInView, page())) loadMore();
  };

  /** A new filter starts again from its first page, at its first row. */
  const restart = () => {
    setLimit(PAGE_SIZE);
    const first = page().runs[0];
    nav.select(first ? rowKey(first.ref) : null);
  };
  const setFilters = (next: ChipFilter) => {
    batch(() => {
      setChips(next);
      setLimit(PAGE_SIZE); // read once, for the new filter's first page
    });
    restart();
  };
  // The text changes as it is typed (and when Esc clears it): the same restart, but not on mount (coming back keeps the place).
  createEffect(on(text.query, restart, { defer: true }));

  const open = (key = nav.selected()) => {
    if (!key) return;
    const ref = refOf(key);
    ui.push({ view: "run", params: { ref } });
  };

  const copy = () => {
    const run = selectedRun();
    if (!run) return;
    if (renderer.copyToClipboardOSC52(run.ref)) ui.toast(`copied ${run.ref}`);
    else ui.toast(`this terminal does not take copies (OSC 52): ${run.ref}`, { error: true });
  };

  useViewKeys(props.keys, {
    ...nav.handlers,
    open: () => open(),
    attach: () => void actions.attach(target()),
    retry: () => actions.retry(target()),
    goto_task: () => {
      const run = selectedRun();
      if (run) ui.push({ view: "task", params: { id: run.task_id } });
    },
    copy,
    cycle_filter: () => setFilters({ ...chips(), status: nextStatus(chips().status) }),
    cycle_since: () => setFilters({ ...chips(), since: nextSince(chips().since) }),
    filter: () => text.open(),
    // Esc dismisses the messages first, then a kept filter.
    dismiss: () => (ui.toasts().length > 0 ? ui.dismiss() : text.clear()),
  });

  const showPreview = () => dims().width >= PREVIEW_MIN_WIDTH;
  const listWidth = () => (showPreview() ? Math.floor(dims().width * 0.55) : dims().width);
  const preview = createMemo(() => {
    store.version();
    const ctx = store.ctx();
    const run = selectedRun();
    return ctx && run ? buildRunPreview(ctx, run) : null;
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box height={1} flexShrink={0} paddingLeft={2}>
        <Line segments={chipSegments(filter(), page())} />
      </box>
      <FilterBar filter={text} />
      <box flexDirection="row" flexGrow={1}>
        <box ref={listBox} flexDirection="row" width={listWidth()} flexShrink={0} onMouseScroll={onWheel}>
          <SectionList sections={sections()} selected={nav.selected()} width={listWidth()} onSelect={nav.select} onOpen={open} />
        </box>
        <Show when={showPreview()}>
          <box flexDirection="column" width={dims().width - listWidth()} flexShrink={0} border={["left"]} borderColor={app.theme.border} paddingLeft={1} paddingRight={1}>
            <Show when={preview()} fallback={<Line segments={[{ text: "Nothing selected.", color: "dim" }]} />}>
              {(p: Accessor<RunPreviewData>) => <RunPreview preview={p()} />}
            </Show>
          </box>
        </Show>
      </box>
    </box>
  );
}

export const RUNS_TAB: TabDef = { title: "Runs", action: "tab_runs", keys: RUNS_KEYS, component: Runs };
