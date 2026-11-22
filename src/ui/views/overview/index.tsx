import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, on, Show } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import { type ListSection, listKeys, SectionList } from "../../components/section-list.tsx";
import { useApp } from "../../context.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import { OVERVIEW_KEYS } from "./keys.ts";
import { overviewSections, parseKey, reconcileSelection, targetOf } from "./model.ts";
import { Preview } from "./preview.tsx";

// Home: what needs you, what runs, what comes next and what just happened,
// with the selection's preview on the right on a wide terminal. The cursor
// moves over every row of every section; a reload keeps it on the same run
// or task (see reconcileSelection).

/** From this width on, the list shares the screen with the preview. */
export const PREVIEW_MIN_WIDTH = 120;
const VIEW = "overview";
/** Rows taken by the header, the tab bar and the footer. */
const CHROME_ROWS = 3;

export function Overview() {
  const app = useApp();
  const { store, ui, actions } = app;
  const dims = useTerminalDimensions();

  const sections = createMemo((): ListSection[] => {
    const dash = store.dash();
    const ctx = store.ctx();
    if (!dash || !ctx) return [];
    return overviewSections({ dash, now: store.now(), timezone: displayTimezone(ctx), seen: app.seen }).map((s) => ({ ...s, color: s.id === "attention" ? ("magenta" as const) : undefined }));
  });
  const keys = createMemo(() => listKeys(sections()), undefined, { equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]) });
  const selected = () => ui.selection(VIEW);

  // Keep the selection on the same run or task when the rows change.
  createEffect(
    on(keys, (now, before) => {
      const next = reconcileSelection(sections(), selected(), before ?? []);
      if (next !== selected()) ui.select(VIEW, next);
    }),
  );

  const showPreview = () => dims().width >= PREVIEW_MIN_WIDTH;
  const listWidth = () => (showPreview() ? Math.floor(dims().width * 0.55) : dims().width);
  const halfPage = () => Math.max(1, Math.floor((dims().height - CHROME_ROWS) / 2));
  const target = () => {
    const dash = store.dash();
    return dash ? targetOf(dash, selected()) : null;
  };

  const moveTo = (index: number) => {
    const all = keys();
    if (all.length === 0) return;
    ui.select(VIEW, all[Math.max(0, Math.min(all.length - 1, index))]!);
  };
  const move = (by: number) => moveTo(Math.max(0, keys().indexOf(selected() ?? "")) + by);
  /** First row of the next (or previous) section that has rows, wrapping around. */
  const jumpSection = (direction: 1 | -1) => {
    const filled = sections().filter((s) => s.rows.length > 0);
    if (filled.length === 0) return;
    const here = filled.findIndex((s) => s.rows.some((r) => r.key === selected()));
    const next = filled[(Math.max(0, here) + direction + filled.length) % filled.length]!;
    ui.select(VIEW, next.rows[0]!.key);
  };

  const open = (key = selected()) => {
    if (!key) return;
    const { section, id } = parseKey(key);
    if (section === "next") return ui.push({ view: "task", params: { id } });
    if (section === "attention") app.seen.markSeen(id);
    ui.push({ view: "run", params: { ref: id } });
  };

  useViewKeys(OVERVIEW_KEYS, {
    down: (n) => move(n),
    up: (n) => move(-n),
    first: () => moveTo(0),
    last: () => moveTo(Infinity),
    half_page_down: () => move(halfPage()),
    half_page_up: () => move(-halfPage()),
    next_panel: () => jumpSection(1),
    prev_panel: () => jumpSection(-1),
    open: () => open(),
    attach: () => void actions.attach(target()),
    retry: () => actions.retry(target()),
    run_now: () => actions.runNow(target()),
    toggle_pause: () => void actions.togglePause(target()),
  });

  return (
    <box flexDirection="row" flexGrow={1}>
      <SectionList sections={sections()} selected={selected()} width={listWidth()} onSelect={(key) => ui.select(VIEW, key)} onOpen={open} />
      <Show when={showPreview()}>
        <Preview rowKey={selected()} width={dims().width - listWidth()} />
      </Show>
    </box>
  );
}
