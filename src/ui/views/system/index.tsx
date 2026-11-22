import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { batch, createEffect, createMemo, createSignal, Index, type JSX, on, onCleanup, Show } from "solid-js";
import { clockTime } from "../../../output/time.ts";
import { displayTimezone } from "../../../task-info.ts";
import type { Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { DOUBLE_CLICK_MS } from "../../components/section-list.tsx";
import { type App, useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { TabDef, ViewProps } from "../types.ts";
import { systemChecks } from "./checks.ts";
import { SYSTEM_KEYS } from "./keys.ts";
import {
  checkLines,
  checksSummary,
  EVENT_FILTER_LABELS,
  type EventFilter,
  eventColumnWidths,
  eventSegments,
  filterEvents,
  hasMachines,
  highlight,
  machineLines,
  machineRows,
  matchingKeys,
  nextEventFilter,
  parseEvents,
  readEventLines,
  readRunnerInfo,
  runnerLines,
  stepMatch,
  systemBadge,
} from "./model.ts";

// The runner and the machine, in panes: Runner (alive, where, ticks; `T`
// ticks now), Events (runner.log with follow, level filter and `/` search;
// Enter opens the run a line names), Machines (hub only; `c` re-checks),
// Checks (doctor, run in the background on the first open and on `c`) and
// Problems (files the data layer could not read). Tab / Shift-Tab move
// between panes, j/k move in the events or scroll the focused pane. Two
// columns on a wide terminal, stacked below.

/** At this width the panes go in two columns. */
export const TWO_COLUMNS_MIN_WIDTH = 120;

type PaneId = "runner" | "events" | "machines" | "checks" | "problems";

/** What the tab keeps while it is not shown (it is mounted again on the way back). */
interface Kept {
  focus: PaneId;
  filter: EventFilter;
  follow: boolean;
  query: string;
}

const kept = new WeakMap<App, Kept>();

const eventRowId = (key: string) => `event:${key}`;

function System(props: ViewProps) {
  const app = useApp();
  const { store, ui, actions, renderer, theme } = app;
  const dims = useTerminalDimensions();
  const checks = systemChecks(app);

  const initial = kept.get(app) ?? { focus: "events", filter: "all", follow: true, query: "" };
  const [focus, setFocus] = createSignal<PaneId>(initial.focus);
  const [filter, setFilter] = createSignal<EventFilter>(initial.filter);
  const [follow, setFollow] = createSignal(initial.follow);
  const [query, setQuery] = createSignal(initial.query);
  /** The search being typed (after `/`), or null when not typing. */
  const [draft, setDraft] = createSignal<string | null>(null);
  createEffect(() => kept.set(app, { focus: focus(), filter: filter(), follow: follow(), query: query() }));

  // The doctor runs once, the first time the tab opens; then on `c`.
  // (Quietly: no toast unless something fails, since nobody asked.)
  if (!checks.doctor.result() && !checks.doctor.running() && !checks.doctor.error()) checks.doctor.run({ quiet: true });

  const tz = () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };

  // --- data -----------------------------------------------------------------

  const runner = createMemo(() => {
    store.version();
    const ctx = store.ctx();
    return ctx ? readRunnerInfo(ctx) : null;
  });
  const allEvents = createMemo(() => {
    store.version();
    const ctx = store.ctx();
    return ctx ? parseEvents(readEventLines(ctx)) : [];
  });
  const events = createMemo(() => filterEvents(allEvents(), filter()));
  const searching = () => draft() ?? query();
  const matches = createMemo(() => matchingKeys(events(), searching()));
  const widths = createMemo(() => eventColumnWidths(events()));
  const showMachines = () => {
    const ctx = store.ctx();
    return ctx !== null && hasMachines(ctx.config.config);
  };
  const machines = createMemo(() => {
    const ctx = store.ctx();
    return ctx ? machineRows(ctx.config.config, [checks.doctor.result(), checks.machines.result()]) : [];
  });
  const problems = () => store.dash()?.errors ?? [];

  const panes = createMemo(() => {
    const all: PaneId[] = ["runner", "events"];
    if (showMachines()) all.push("machines");
    all.push("checks");
    if (problems().length > 0) all.push("problems");
    return all;
  });
  // A pane that went away (no more problems) hands the focus to the events.
  createEffect(() => {
    if (!panes().includes(focus())) setFocus("events");
  });

  // --- the event cursor -----------------------------------------------------

  const [selected, setSelected] = createSignal<string | null>(ui.selection("system"));
  createEffect(() => ui.select("system", selected()));
  // Following: the cursor sticks to the last line as lines arrive. Otherwise
  // it stays on its line, or goes to the line now at its place when its line
  // is filtered out (or rolled out of the tail).
  createEffect(
    on(events, (rows, before) => {
      if (rows.length === 0) return setSelected(null);
      const current = selected();
      if (follow() || current === null) return setSelected(rows.at(-1)!.key);
      if (rows.some((r) => r.key === current)) return;
      const at = (before ?? []).findIndex((r) => r.key === current);
      setSelected(rows[Math.max(0, Math.min(rows.length - 1, at))]!.key);
    }),
  );
  createEffect(on(follow, (following) => following && events().length > 0 && setSelected(events().at(-1)!.key)));

  const scrolls: Partial<Record<PaneId, ScrollBoxRenderable>> = {};
  createEffect(
    on(selected, (key) => {
      const scroll = scrolls.events;
      if (!key || !scroll) return;
      // At the end of the log, keep the very bottom in view (the last line may be cut by the pane).
      if (follow()) scroll.scrollTo(scroll.scrollHeight);
      else scroll.scrollChildIntoView(eventRowId(key));
    }),
  );

  const selectEvent = (key: string | null, keepFollow = false) => {
    if (key === null) return;
    batch(() => {
      setSelected(key);
      // Moving off the last line stops following; landing on it does not start it (F does).
      if (!keepFollow && key !== events().at(-1)?.key) setFollow(false);
    });
  };
  const moveEvent = (by: number) => {
    const rows = events();
    if (rows.length === 0) return;
    const here = Math.max(0, rows.findIndex((r) => r.key === selected()));
    selectEvent(rows[Math.max(0, Math.min(rows.length - 1, here + by))]!.key);
  };

  const selectedEvent = () => events().find((r) => r.key === selected()) ?? null;
  const open = (key = selected()) => {
    const ref = events().find((r) => r.key === key)?.ref;
    if (ref) ui.push({ view: "run", params: { ref } });
    else if (key) ui.toast("this line names no run");
  };

  // --- moving and scrolling -------------------------------------------------

  const halfPage = () => Math.max(1, Math.floor((scrolls[focus()]?.height ?? renderer.height / 2) / 2));
  const scrollFocused = (by: number | "top" | "bottom") => {
    const scroll = scrolls[focus()];
    if (!scroll) return;
    if (by === "top") scroll.scrollTo(0);
    else if (by === "bottom") scroll.scrollTo(scroll.scrollHeight);
    else scroll.scrollBy(by);
  };
  /** In the events a motion moves the cursor; in another pane it scrolls. */
  const motion = (inEvents: () => void, elsewhere: () => void) => (focus() === "events" ? inEvents() : elsewhere());
  const cyclePane = (by: 1 | -1) => {
    const all = panes();
    setFocus(all[(all.indexOf(focus()) + by + all.length) % all.length]!);
  };

  // --- search ---------------------------------------------------------------

  /** `here`: the cursor's line if it matches, else the nearest match above it (a log is read from its end). */
  const jumpToMatch = (direction: 1 | -1 | "here") => {
    const from = selected();
    const key = direction === "here" ? (from !== null && matches().includes(from) ? from : stepMatch(events(), matches(), from, -1)) : stepMatch(events(), matches(), from, direction);
    if (key === null) {
      if (searching()) ui.toast(`no line matches "${searching()}"`);
      return;
    }
    setFocus("events");
    selectEvent(key);
  };

  // While the search is typed, every key goes to it (taken before the keymap
  // sees it): characters, Backspace, Enter keeps it, Esc clears it.
  onCleanup(
    app.keymap.intercept(
      "key",
      (ctx) => {
        const typed = draft();
        if (typed === null) return;
        ctx.consume();
        const e = ctx.event;
        if (e.name === "escape") {
          batch(() => {
            setDraft(null);
            setQuery("");
          });
        } else if (e.name === "return") {
          batch(() => {
            setDraft(null);
            setQuery(typed);
          });
          if (typed !== "") jumpToMatch("here");
        } else if (e.name === "backspace") {
          setDraft(typed.slice(0, -1));
        } else if (!e.ctrl && !e.meta && e.sequence.length === 1 && e.sequence >= " ") {
          setDraft(typed + e.sequence);
        }
      },
      { priority: 60 },
    ),
  );

  // --- actions --------------------------------------------------------------

  const recheck = () => {
    if (focus() === "machines") checks.machines.run();
    else checks.doctor.run();
  };
  let ticking = false;
  const tickNow = () => {
    if (ticking) return void ui.toast("a tick is already running");
    ui.ask({
      title: "Run one tick now?",
      consequence: "It may launch the runs that are due.",
      onYes: () => {
        ticking = true;
        void actions
          .background(["tick"], "ticking")
          .then(({ code, first }) => actions.report(code, first, "ticking"))
          .finally(() => (ticking = false));
      },
    });
  };
  const copy = () => {
    const row = selectedEvent();
    if (!row) return;
    if (row.ref) actions.copy(row.ref, `run ref ${row.ref}`);
    else actions.copy([row.time, row.mark, row.task, row.what, row.note].filter((t) => t).join(" "), "line");
  };

  useViewKeys(props.keys, {
    down: (n) => motion(() => moveEvent(n), () => scrollFocused(n)),
    up: (n) => motion(() => moveEvent(-n), () => scrollFocused(-n)),
    first: () => motion(() => selectEvent(events()[0]?.key ?? null), () => scrollFocused("top")),
    // In the events, going to the end follows it again.
    last: () => motion(() => setFollow(true), () => scrollFocused("bottom")),
    half_page_down: () => motion(() => moveEvent(halfPage()), () => scrollFocused(halfPage())),
    half_page_up: () => motion(() => moveEvent(-halfPage()), () => scrollFocused(-halfPage())),
    next_panel: () => cyclePane(1),
    prev_panel: () => cyclePane(-1),
    open: () => (focus() === "events" ? open() : undefined),
    cycle_filter: () => {
      setFilter(nextEventFilter(filter()));
      setFocus("events");
    },
    toggle_follow: () => {
      setFollow(!follow());
      setFocus("events");
    },
    search: () => {
      setFocus("events");
      setDraft("");
    },
    // Esc clears a kept search first, then dismisses the toasts as everywhere.
    dismiss: () => (query() ? setQuery("") : ui.dismiss()),
    next_match: () => jumpToMatch(1),
    prev_match: () => jumpToMatch(-1),
    copy,
    tick_now: tickNow,
    recheck,
  });

  // --- drawing --------------------------------------------------------------

  const key = (action: Parameters<typeof keyHint>[1]) => keyHint(app.config.keymap, action) ?? "";
  const wide = () => dims().width >= TWO_COLUMNS_MIN_WIDTH;

  const Pane = (p: { id: PaneId; title: string; grow?: number; height?: number; children: JSX.Element }) => {
    const focused = () => focus() === p.id;
    return (
      <box
        flexDirection="column"
        flexGrow={p.height === undefined ? (p.grow ?? 1) : 0}
        flexShrink={p.height === undefined ? 1 : 0}
        height={p.height}
        minHeight={3}
        border
        borderStyle="rounded"
        borderColor={focused() ? theme.cyan : theme.border}
        title={` ${p.title} `}
        titleAlignment="left"
        onMouseDown={() => setFocus(p.id)}
        // Scrolling up through the events to read them stops following (or the next line would pull the view back down).
        onMouseScroll={(e: MouseEvent) => p.id === "events" && e.scroll?.direction === "up" && setFollow(false)}
      >
        <scrollbox ref={(el: ScrollBoxRenderable) => (scrolls[p.id] = el)} flexGrow={1} scrollY scrollX={false} paddingLeft={1} paddingRight={1}>
          {p.children}
        </scrollbox>
      </box>
    );
  };

  /** Lines of segments; Index, so a reload (or the clock) updates them in place. */
  /**
   * Lines of segments; Index, so a reload (or the clock) updates them in
   * place. Wrapped, a line's first segment (`✓ `, `  fix: `) is a hanging
   * indent: the rest wraps beside it, not under it.
   */
  const Lines = (p: { all: readonly Segment[][]; wrap?: boolean }) => (
    <Index each={p.all}>
      {(segments) =>
        p.wrap && segments().length > 1 ? (
          <box flexDirection="row" flexShrink={0}>
            <box width={Bun.stringWidth(segments()[0]!.text)} flexShrink={0}>
              <Line segments={[segments()[0]!]} />
            </box>
            <box flexGrow={1} flexShrink={1}>
              <Line segments={segments().slice(1)} wrap />
            </box>
          </box>
        ) : (
          <Line segments={segments()} wrap={p.wrap} />
        )
      }
    </Index>
  );

  const runnerContent = createMemo((): Segment[][] => {
    const info = runner();
    return [...(info ? runnerLines(info, tz(), store.now()) : []), [{ text: `${key("tick_now")} tick now`, color: "dim" }]];
  });
  const RunnerPane = () => (
    <Pane id="runner" title="Runner" height={runnerContent().length + 2}>
      <Lines all={runnerContent()} />
    </Pane>
  );

  const eventStatus = (): Segment[] => {
    const typed = draft();
    const out: Segment[] = [
      { text: follow() ? "● following" : "○ not following", color: follow() ? "green" : "dim" },
      { text: ` (${key("toggle_follow")})  ·  `, color: "dim" },
      { text: `level: ${EVENT_FILTER_LABELS[filter()]}` },
      { text: ` (${key("cycle_filter")})`, color: "dim" },
    ];
    if (typed !== null) out.push({ text: "  ·  " }, { text: `/${typed}`, color: "yellow" }, { text: "▏" }, { text: "  ⏎ keep · esc clear", color: "dim" });
    else if (query()) out.push({ text: "  ·  " }, { text: `/${query()}`, color: "yellow" }, { text: `  ${matches().length} match${matches().length === 1 ? "" : "es"} · ${key("next_match")}/${key("prev_match")} · ${key("dismiss")} clear`, color: "dim" });
    return out;
  };

  let lastClick = { key: "", at: 0 };
  const clickEvent = (rowKey: string, e: MouseEvent) => {
    if (e.button !== 0) return;
    const now = Date.now();
    const double = lastClick.key === rowKey && now - lastClick.at < DOUBLE_CLICK_MS;
    lastClick = { key: rowKey, at: double ? 0 : now };
    setFocus("events");
    selectEvent(rowKey);
    if (double) open(rowKey);
  };

  const EventsPane = (p: { grow: number }) => (
    <box flexDirection="column" flexGrow={p.grow} minHeight={5}>
      <Pane id="events" title={`Events · ${events().length}${filter() === "all" ? "" : ` of ${allEvents().length}`}`} grow={1}>
        <Show when={events().length > 0} fallback={<Line segments={[{ text: allEvents().length === 0 ? "runner.log is empty (the runner writes it as it works)" : "no events at this level", color: "dim" }]} />}>
          {/* Index: rows are rebuilt on every reload; their renderables stay. */}
          <Index each={events()}>
            {(row) => {
              const isSelected = () => row().key === selected() && focus() === "events";
              const segments = () => highlight(eventSegments(row(), widths().task, widths().what), searching());
              return (
                <box id={eventRowId(row().key)} height={1} flexShrink={0} onMouseDown={(e: MouseEvent) => clickEvent(row().key, e)}>
                  <Line segments={isSelected() ? [{ text: segments().map((s) => s.text).join("") }] : segments()} inverse={isSelected()} />
                </box>
              );
            }}
          </Index>
        </Show>
      </Pane>
      <box height={1} flexShrink={0} paddingLeft={2}>
        <Line segments={eventStatus()} />
      </box>
    </box>
  );

  const machinesContent = createMemo((): Segment[][] => {
    const m = checks.machines;
    return [
      ...machines().flatMap((row) => machineLines(row, tz(), store.now(), m.running() || (checks.doctor.running() && row.check === null))),
      ...(m.error() ? [[{ text: `machines check failed: ${m.error()}`, color: "red" as const }]] : []),
      [{ text: `${key("recheck")} check again${m.running() ? " · checking…" : ""}`, color: "dim" }],
    ];
  });
  const MachinesPane = () => (
    <Pane id="machines" title={`Machines · ${machines().length}`} grow={1}>
      <Lines all={machinesContent()} wrap />
    </Pane>
  );

  const checksContent = createMemo((): Segment[][] => {
    const doctor = checks.doctor;
    const result = doctor.result();
    let head: Segment[];
    if (!result) head = [{ text: doctor.running() ? "running agent-tasks doctor…" : "not checked yet", color: "dim" }];
    else {
      const color = result.checks.some((c) => c.status === "error") ? "red" : result.checks.some((c) => c.status === "warn") ? "yellow" : "green";
      head = [
        { text: checksSummary(result.checks), color },
        { text: ` · checked ${clockTime(result.at, tz())}${doctor.running() ? " · checking…" : ""} · ${key("recheck")} again`, color: "dim" },
      ];
    }
    return [head, ...(doctor.error() ? [[{ text: `doctor failed: ${doctor.error()}`, color: "red" as const }]] : []), ...(result?.checks ?? []).flatMap(checkLines)];
  });
  const ChecksPane = () => (
    <Pane id="checks" title="Checks" grow={2}>
      <Lines all={checksContent()} wrap />
    </Pane>
  );

  const problemsContent = createMemo((): Segment[][] => [[{ text: "Files the dashboard could not read:", color: "dim" }], ...problems().map((p): Segment[] => [{ text: "✕ ", color: "red" }, { text: p }])]);
  const ProblemsPane = () => (
    <Pane id="problems" title={`Problems · ${problems().length}`} grow={1}>
      <Lines all={problemsContent()} wrap />
    </Pane>
  );

  return (
    <Show
      when={wide()}
      fallback={
        <box flexDirection="column" flexGrow={1}>
          <RunnerPane />
          <EventsPane grow={2} />
          <Show when={showMachines()}>
            <MachinesPane />
          </Show>
          <ChecksPane />
          <Show when={problems().length > 0}>
            <ProblemsPane />
          </Show>
        </box>
      }
    >
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width="55%" flexShrink={0}>
          <RunnerPane />
          <EventsPane grow={1} />
        </box>
        <box flexDirection="column" flexGrow={1}>
          <Show when={showMachines()}>
            <MachinesPane />
          </Show>
          <ChecksPane />
          <Show when={problems().length > 0}>
            <ProblemsPane />
          </Show>
        </box>
      </box>
    </Show>
  );
}

export const SYSTEM_TAB: TabDef = {
  title: "System",
  action: "tab_system",
  keys: SYSTEM_KEYS,
  component: System,
  badge: (app) => {
    const ctx = app.store.ctx();
    const checks = systemChecks(app);
    const machines = ctx ? machineRows(ctx.config.config, [checks.doctor.result(), checks.machines.result()]) : [];
    return systemBadge(checks.doctor.result(), machines, app.store.dash()?.errors.length ?? 0);
  },
};
