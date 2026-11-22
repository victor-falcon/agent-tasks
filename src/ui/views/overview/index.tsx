import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import { useListNavigation } from "../../components/list-navigation.ts";
import { PREVIEW_MIN_WIDTH } from "../../components/run-preview.tsx";
import { type ListSection, SectionList } from "../../components/section-list.tsx";
import { useApp } from "../../context.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { TabDef, ViewProps } from "../types.ts";
import { OVERVIEW_KEYS } from "./keys.ts";
import { overviewSections, parseKey, targetOf } from "./model.ts";
import { Preview } from "./preview.tsx";

// Home: what needs you, what runs, what comes next and what just happened,
// with the selection's preview on the right on a wide terminal. The cursor
// moves over every row of every section; a reload keeps it on the same run
// or task (see reconcileSelection).

// Kept here too for views that already import it from the Overview.
export { PREVIEW_MIN_WIDTH };

function Overview(props: ViewProps) {
  const app = useApp();
  const { store, ui, actions } = app;
  const dims = useTerminalDimensions();

  const sections = createMemo((): ListSection[] => {
    const dash = store.dash();
    const ctx = store.ctx();
    if (!dash || !ctx) return [];
    return overviewSections({ dash, now: store.now(), timezone: displayTimezone(ctx), seen: app.seen }).map((s) => ({ ...s, color: s.id === "attention" ? ("magenta" as const) : undefined }));
  });
  const nav = useListNavigation("overview", sections);

  const showPreview = () => dims().width >= PREVIEW_MIN_WIDTH;
  const listWidth = () => (showPreview() ? Math.floor(dims().width * 0.55) : dims().width);
  const target = () => {
    const dash = store.dash();
    return dash ? targetOf(dash, nav.selected()) : null;
  };

  const open = (key = nav.selected()) => {
    if (!key) return;
    const { section, id } = parseKey(key);
    if (section === "next") return ui.push({ view: "task", params: { id } });
    if (section === "attention") app.seen.markSeen(id);
    ui.push({ view: "run", params: { ref: id } });
  };

  useViewKeys(props.keys, {
    ...nav.handlers,
    open: () => open(),
    attach: () => void actions.attach(target()),
    retry: () => actions.retry(target()),
    run_now: () => actions.runNow(target()),
    toggle_pause: () => void actions.togglePause(target()),
  });

  return (
    <box flexDirection="row" flexGrow={1}>
      <SectionList sections={sections()} selected={nav.selected()} width={listWidth()} onSelect={nav.select} onOpen={open} />
      <Show when={showPreview()}>
        <Preview rowKey={nav.selected()} width={dims().width - listWidth()} />
      </Show>
    </box>
  );
}

export const OVERVIEW_TAB: TabDef = { title: "Overview", action: "tab_overview", keys: OVERVIEW_KEYS, component: Overview };
