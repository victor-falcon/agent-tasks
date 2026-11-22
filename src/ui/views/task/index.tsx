import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { type Accessor, createMemo, Index, Match, Show, Switch } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { SectionList } from "../../components/section-list.tsx";
import { type Handler, useApp } from "../../context.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import { taskHandlers } from "../tasks/handlers.ts";
import { cycle, idOfKey, type TaskItem, titleSegments } from "../tasks/model.ts";
import type { ViewDef, ViewProps } from "../types.ts";
import { TASK_KEYS } from "./keys.ts";
import { readTaskItem, runSections, SUBTAB_TITLES, SUBTABS, type SubTab } from "./model.ts";
import { InstructionsPart, OverviewPart, SettingsPart } from "./parts.tsx";

// One task, opened with `ui.push({ view: "task", params: { id } })`, in four
// parts (`[`/`]` or <Tab>): its Overview, its Instructions (`i` shows them as
// the agent receives them), its Runs (Enter opens one) and its resolved
// Settings with where each comes from. Archived tasks open too, read-only.
// The part shown is kept per task in the UI state, so coming back from a
// run finds the same part.

function Task(props: ViewProps) {
  const app = useApp();
  const { store, ui } = app;
  const dims = useTerminalDimensions();
  const id = props.params.id ?? "";
  const [subtab, setSubtab] = ui.viewState<SubTab>(`task:${id}:subtab`, "overview");
  const [asAgent, setAsAgent] = ui.viewState(`task:${id}:as_agent`, false);
  let scroll: ScrollBoxRenderable | undefined;

  // Read again on each reload (store.version), not on each clock tick.
  const read = createMemo(() => {
    store.version();
    const ctx = store.ctx();
    return ctx ? readTaskItem(ctx, id) : { item: null, error: null };
  });
  const item = () => read().item;
  const tz = () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };

  const runs = createMemo(() => {
    const it = item();
    return it ? runSections(it, store.now(), tz()) : [];
  });
  const nav = useListNavigation(`task:${id}:runs`, runs);

  const go = (by: 1 | -1) => setSubtab(by === 1 ? cycle(SUBTABS, subtab()) : cycle([...SUBTABS].reverse(), subtab()));
  const onRuns = () => subtab() === "runs";
  /** j/k move in the runs, and scroll the other parts. */
  const scrollBy = (rows: number) => scroll?.scrollBy(rows);
  const halfPage = () => Math.max(1, Math.floor((dims().height - 6) / 2));
  /** The list's own handler on the Runs part, `scrolled` on the others. */
  const listOr = (action: "down" | "up" | "first" | "last" | "half_page_down" | "half_page_up", scrolled: Handler): Handler => (n) => (onRuns() ? nav.handlers[action]!(n) : scrolled(n));
  const openRun = (key = nav.selected()) => key && ui.push({ view: "run", params: { ref: idOfKey(key) } });

  useViewKeys(props.keys, {
    ...taskHandlers(app, item),
    next_subtab: () => go(1),
    prev_subtab: () => go(-1),
    next_panel: () => go(1),
    prev_panel: () => go(-1),
    // From another part, `i` shows the instructions as they were left; on them, it switches version.
    toggle_instructions: () => (subtab() === "instructions" ? setAsAgent(!asAgent()) : setSubtab("instructions")),
    down: listOr("down", (n) => scrollBy(n)),
    up: listOr("up", (n) => scrollBy(-n)),
    first: listOr("first", () => scroll?.scrollTo(0)),
    last: listOr("last", () => scroll?.scrollTo(scroll.scrollHeight)),
    half_page_down: listOr("half_page_down", () => scrollBy(halfPage())),
    half_page_up: listOr("half_page_up", () => scrollBy(-halfPage())),
    open: () => onRuns() && openRun(),
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <Show when={item()} fallback={<Line segments={[{ text: read().error ? `  ${read().error}` : "  loading…", color: read().error ? "red" : "dim" }]} />}>
        {(get: Accessor<TaskItem>) => (
          <>
            {/* The header keeps its rows whatever the part below holds. */}
            <box flexDirection="column" flexShrink={0}>
              <Line segments={titleSegments(get())} />
              <box flexDirection="row" height={1} flexShrink={0} gap={3}>
                <Index each={SUBTABS}>
                  {(tab) => (
                    <box height={1} onMouseDown={() => setSubtab(tab())}>
                      <Line
                        segments={[{ text: tab() === "runs" ? `${SUBTAB_TITLES[tab()]} (${get().runs.length})` : SUBTAB_TITLES[tab()], color: subtab() === tab() ? "cyan" : "dim" }]}
                        bold={subtab() === tab()}
                      />
                    </box>
                  )}
                </Index>
              </box>
              <Line segments={[{ text: "─".repeat(Math.max(0, dims().width - 2)), color: "dim" }]} />
            </box>
            <Show when={subtab() === "runs"}>
              <SectionList sections={runs()} selected={nav.selected()} width={dims().width - 2} onSelect={nav.select} onOpen={openRun} />
            </Show>
            <Show when={subtab() !== "runs"}>
              <scrollbox ref={scroll} flexGrow={1} scrollY scrollX={false}>
                <Switch>
                  <Match when={subtab() === "overview"}>
                    <OverviewPart item={get()} />
                  </Match>
                  <Match when={subtab() === "instructions"}>
                    <InstructionsPart item={get()} asAgent={asAgent()} />
                  </Match>
                  <Match when={subtab() === "settings"}>
                    <SettingsPart item={get()} />
                  </Match>
                </Switch>
              </scrollbox>
            </Show>
          </>
        )}
      </Show>
    </box>
  );
}

export const TASK_VIEW: ViewDef = { keys: TASK_KEYS, component: Task };
