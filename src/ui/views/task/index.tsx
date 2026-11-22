import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { type Accessor, createMemo, For, Index, Match, Show, Switch } from "solid-js";
import { scheduleText } from "../../../output/schedule-text.ts";
import { TASK_MARKS } from "../../../output/symbols.ts";
import { agendaTime, relativeTime } from "../../../output/time.ts";
import { describeSchedule } from "../../../task-info.ts";
import { fitText, type Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useListNavigation } from "../../components/list-navigation.ts";
import { SectionList } from "../../components/section-list.tsx";
import { useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import { taskHandlers } from "../tasks/index.tsx";
import { cycle, settingsSummary, type TaskItem } from "../tasks/model.ts";
import type { ViewDef, ViewProps } from "../types.ts";
import { TASK_KEYS } from "./keys.ts";
import { instructionsOf, readTaskItem, runSections, settingRows, SUBTAB_TITLES, SUBTABS, type SubTab } from "./model.ts";

// One task, opened with `ui.push({ view: "task", params: { id } })`, in four
// parts (`[`/`]` or <Tab>): its Overview, its Instructions (`i` shows them as
// the agent receives them), its Runs (Enter opens one) and its resolved
// Settings with where each comes from. Archived tasks open too, read-only.
// The part shown is kept per task in the UI state, so coming back from a
// run finds the same part.

function Task(props: ViewProps) {
  const app = useApp();
  const { store, ui, theme } = app;
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
  const tz = () => item()?.resolution.timezone ?? "UTC";

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
  const openRun = (key = nav.selected()) => key && ui.push({ view: "run", params: { ref: key.slice(key.indexOf(":") + 1) } });

  useViewKeys(props.keys, {
    ...taskHandlers(app, item),
    next_subtab: () => go(1),
    prev_subtab: () => go(-1),
    next_panel: () => go(1),
    prev_panel: () => go(-1),
    toggle_instructions: () => {
      setSubtab("instructions");
      setAsAgent(!asAgent());
    },
    down: (n) => (onRuns() ? nav.handlers.down!(n) : scrollBy(n)),
    up: (n) => (onRuns() ? nav.handlers.up!(n) : scrollBy(-n)),
    first: (n) => (onRuns() ? nav.handlers.first!(n) : scroll?.scrollTo(0)),
    last: (n) => (onRuns() ? nav.handlers.last!(n) : scroll?.scrollTo(scroll.scrollHeight)),
    half_page_down: (n) => (onRuns() ? nav.handlers.half_page_down!(n) : scrollBy(halfPage())),
    half_page_up: (n) => (onRuns() ? nav.handlers.half_page_up!(n) : scrollBy(-halfPage())),
    open: () => onRuns() && openRun(),
  });

  const title = (it: TaskItem): Segment[] => {
    const mark = TASK_MARKS[it.mark];
    return [{ text: `${mark.symbol} `, color: mark.color }, { text: it.task.title, color: "bold" }, { text: ` · ${it.task.id} · ${it.state}`, color: "dim" }];
  };

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <Show when={item()} fallback={<Line segments={[{ text: read().error ? `  ${read().error}` : "  loading…", color: read().error ? "red" : "dim" }]} />}>
        {(get: Accessor<TaskItem>) => (
          <>
            {/* The header keeps its rows whatever the part below holds. */}
            <box flexDirection="column" flexShrink={0}>
              <Line segments={title(get())} />
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
            <Switch>
              <Match when={subtab() === "runs"}>
                <SectionList sections={runs()} selected={nav.selected()} width={dims().width - 2} onSelect={nav.select} onOpen={openRun} />
              </Match>
              <Match when={true}>
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
              </Match>
            </Switch>
          </>
        )}
      </Show>
    </box>
  );

  function OverviewPart(p: { item: TaskItem }) {
    const row = (label: string, value: Segment[]) => <Line segments={[{ text: fitText(label, 12), color: "dim" }, ...value]} wrap />;
    return (
      <box flexDirection="column">
        <Show when={p.item.task.description}>
          <Line segments={[{ text: p.item.task.description! }]} wrap />
          <Line segments={[{ text: "" }]} />
        </Show>
        {row("Id", [{ text: p.item.task.id }])}
        {row("State", [{ text: p.item.state, color: p.item.state === "active" ? "green" : "dim" }])}
        {row("Folder", [{ text: p.item.task.cwd }, ...(keyHint(app.config.keymap, "open_folder") ? [{ text: `  ${keyHint(app.config.keymap, "open_folder")} open a shell there`, color: "dim" as const }] : [])])}
        {row("Machine", [{ text: p.item.task.machine }])}
        {row("Schedule", [{ text: scheduleText(p.item.task.schedule, tz(), store.now()) }])}
        {row("", [{ text: describeSchedule(p.item.task), color: "dim" }])}
        {row("Time zone", [{ text: p.item.resolution.timezone }])}
        <Line segments={[{ text: "" }]} />
        <Line segments={[{ text: "Next runs", color: "dim" }]} />
        <Show when={p.item.next.length > 0} fallback={<Line segments={[{ text: `  none (${p.item.state})`, color: "dim" }]} />}>
          <For each={p.item.next}>{(slot) => <Line segments={[{ text: `  ${agendaTime(new Date(slot), tz(), store.now())}` }, { text: `  ${relativeTime(new Date(slot), store.now())}`, color: "dim" }]} />}</For>
        </Show>
        <Line segments={[{ text: "" }]} />
        <For each={settingsSummary(p.item.resolution)}>{(s) => row(s.label, [{ text: s.value }])}</For>
      </box>
    );
  }

  function InstructionsPart(p: { item: TaskItem; asAgent: boolean }) {
    const text = createMemo(() => {
      const ctx = store.ctx();
      return ctx ? instructionsOf(ctx, p.item, p.asAgent) : null;
    });
    const toggle = keyHint(app.config.keymap, "toggle_instructions");
    const note = (): Segment[] => {
      const t = text();
      if (!t) return [];
      const personal = t.personal === 0 ? "" : ` and ${t.personal} personal file${t.personal === 1 ? "" : "s"}`;
      const what = p.asAgent ? `As the agent receives them: the template, the task's instructions${personal}.` : "As written in the task.";
      return [{ text: what, color: "dim" }, ...(toggle ? [{ text: `  ${toggle} ${p.asAgent ? "as written" : "as the agent receives them"}`, color: "dim" as const }] : [])];
    };
    return (
      <box flexDirection="column">
        <Line segments={note()} wrap />
        <For each={text()?.missing ?? []}>{(path) => <Line segments={[{ text: `missing personal file: ${path}`, color: "yellow" }]} />}</For>
        <Line segments={[{ text: "" }]} />
        <markdown content={text()?.text ?? ""} syntaxStyle={theme.syntax} fg={theme.fg} bg={theme.bg} conceal />
      </box>
    );
  }

  function SettingsPart(p: { item: TaskItem }) {
    const rows = createMemo(() => {
      const ctx = store.ctx();
      return ctx ? settingRows(ctx, p.item) : [];
    });
    const keyWidth = () => Math.max(...rows().map((r) => r.key.length));
    const valueWidth = () => Math.min(56, Math.max(...rows().map((r) => Bun.stringWidth(r.value))));
    return (
      <box flexDirection="column">
        <Line segments={[{ text: "Every setting a run gets and where it comes from (task > profile > config > default). Read-only.", color: "dim" }]} wrap />
        <Line segments={[{ text: "" }]} />
        <For each={rows()}>
          {(r) => <Line segments={[{ text: r.key.padEnd(keyWidth()), color: "dim" }, { text: "  " }, { text: fitText(r.value, valueWidth()) }, { text: "  " }, { text: `← ${r.source}`, color: r.source === "task" ? "cyan" : "dim" }]} />}
        </For>
      </box>
    );
  }
}

export const TASK_VIEW: ViewDef = { keys: TASK_KEYS, component: Task };
