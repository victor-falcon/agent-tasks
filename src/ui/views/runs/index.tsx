import { useTerminalDimensions } from "@opentui/solid";
import { type Accessor, createEffect, createMemo, createSignal, Show } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import type { Target } from "../../actions.ts";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { buildRunPreview, RunPreview, type RunPreviewData } from "../../components/run-preview.tsx";
import { type ListSection, SectionList } from "../../components/section-list.tsx";
import { type App, useApp } from "../../context.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import { PREVIEW_MIN_WIDTH } from "../overview/index.tsx";
import type { TabDef, ViewProps } from "../types.ts";
import { RUNS_KEYS } from "./keys.ts";
import { chipSegments, DEFAULT_FILTER, loadRuns, needsMore, nextSince, nextStatus, PAGE_SIZE, refOf, rowKey, runCells, type RunsFilter, type RunsPage } from "./model.ts";

// The whole history, newest first, a page at a time: the next page is read
// when the cursor gets near the end of what is loaded. Above the list, the
// filters as chips (`f` status, `S` since); on a wide terminal, the selected
// run's preview on the right. The selection follows the run's ref across
// reloads and pages.

/** What the tab keeps while a detail is open on top of it (the component is mounted again on the way back). */
interface Kept {
  filter: RunsFilter;
  limit: number;
}

const kept = new WeakMap<App, Kept>();

function Runs(props: ViewProps) {
  const app = useApp();
  const { store, ui, actions, renderer } = app;
  const dims = useTerminalDimensions();

  const initial = kept.get(app) ?? { filter: DEFAULT_FILTER, limit: PAGE_SIZE };
  const [filter, setFilter] = createSignal<RunsFilter>(initial.filter);
  const [limit, setLimit] = createSignal(initial.limit);
  createEffect(() => kept.set(app, { filter: filter(), limit: limit() }));

  // Read again on every reload (store.version) and when the filters or the
  // page count change; not on every clock tick.
  const page = createMemo((): RunsPage => {
    store.version();
    const ctx = store.ctx();
    return ctx ? loadRuns(ctx, filter(), limit()) : { runs: [], more: false };
  });

  const sections = createMemo((): ListSection[] => {
    const ctx = store.ctx();
    if (!ctx) return [];
    const tz = displayTimezone(ctx);
    const now = store.now();
    const filtered = filter().status !== "all" || filter().since !== "all" || filter().text !== "";
    return [
      {
        id: "runs",
        title: "Runs",
        rows: page().runs.map((r) => ({ key: rowKey(r.ref), cells: runCells(r, tz, now) })),
        empty: filtered ? "no runs match these filters" : "no runs yet",
      },
    ];
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

  // Near the end of what is loaded: read the next page.
  createEffect(() => {
    const p = page();
    const index = p.runs.findIndex((r) => r.ref === selectedRun()?.ref);
    if (index >= 0 && needsMore(index, p.runs.length, p.more)) setLimit((l) => l + PAGE_SIZE);
  });

  const setAndReset = (next: RunsFilter) => {
    setFilter(next);
    setLimit(PAGE_SIZE); // a new filter starts again from its first page
  };

  const open = (key = nav.selected()) => {
    if (!key) return;
    const ref = refOf(key);
    // Opening a failure counts as having seen it (it leaves Needs attention).
    app.seen.markSeen(ref);
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
    cycle_filter: () => setAndReset({ ...filter(), status: nextStatus(filter().status) }),
    cycle_since: () => setAndReset({ ...filter(), since: nextSince(filter().since) }),
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
      {/* The filter chips. T6 puts the shared `/` filter bar (components/filter-bar.tsx) on this line; it sets filter().text. */}
      <box height={1} flexShrink={0} paddingLeft={2}>
        <Line segments={chipSegments(filter(), page())} />
      </box>
      <box flexDirection="row" flexGrow={1}>
        <SectionList sections={sections()} selected={nav.selected()} width={listWidth()} onSelect={nav.select} onOpen={open} />
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
