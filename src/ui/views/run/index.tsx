import type { BoxRenderable, MouseEvent, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { type Accessor, createMemo, createSignal, For, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { displayTimezone } from "../../../task-info.ts";
import { fitText, type Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { useViewKeys } from "../../keymap/layer.ts";
import type { UiState } from "../../state.ts";
import type { ViewDef, ViewProps } from "../types.ts";
import { RUN_KEYS } from "./keys.ts";
import { type Block, buildRunModel, type Geometry, logRows, logSegments, matchRows, moveInRun, nextMatch, type Place, resultFacts, reveal, type RunModel, type RunSection, runTitle, type SectionId } from "./model.ts";

// One run, what it did first: its result (the summary as Markdown) and its
// --output-file open, then folded sections for the details, the attempts,
// the events and the captured log. j/k move between sections and scroll
// through a long open one, as in the old dashboard; `/` searches the log.
// The run is read again on every reload, keeping the folds, the selection
// and the scroll; leaving and coming back (to its task and back) finds them
// as they were.

/** What the view keeps of a run when it is left, to find it as it was. */
interface Saved {
  folds: Partial<Record<SectionId, boolean>>;
  selected: SectionId | null;
  scroll: number;
  query: string;
  match: number | null;
}

/** Per dashboard (its UI state) and run ref. */
const SAVED = new WeakMap<UiState, Map<string, Saved>>();

function savedOf(ui: UiState): Map<string, Saved> {
  let map = SAVED.get(ui);
  if (!map) SAVED.set(ui, (map = new Map()));
  return map;
}

/** Columns taken around a section's text: the padding on both sides and the scrollbar. */
const GUTTER = 3;

function RunDetail(props: ViewProps) {
  const app = useApp();
  const { store, ui, actions, theme } = app;
  const dims = useTerminalDimensions();
  const ref = () => props.params.ref ?? "";
  const tz = () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };

  // Read again on every reload (store.version), not on every clock tick.
  const loaded = createMemo((): { model: RunModel | null; error: string | null } => {
    store.version();
    const ctx = store.ctx();
    if (!ctx) return { model: null, error: null };
    try {
      return { model: buildRunModel(ctx, ref(), tz()), error: null };
    } catch (err) {
      return { model: null, error: (err as Error).message };
    }
  });
  const model = () => loaded().model;
  const ids = createMemo(() => model()?.sections.map((s) => s.id) ?? [], [] as SectionId[], { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
  const sectionOf = (id: SectionId) => model()?.sections.find((s) => s.id === id) ?? null;

  const saved = savedOf(ui).get(ref());
  const [folds, setFolds] = createSignal<Partial<Record<SectionId, boolean>>>(saved?.folds ?? {});
  const [selectedId, setSelectedId] = createSignal<SectionId | null>(saved?.selected ?? null);
  const selected = () => {
    const all = ids();
    const index = all.indexOf(selectedId() as SectionId);
    return index === -1 ? 0 : index;
  };
  const isOpen = (section: RunSection) => folds()[section.id] ?? section.open;

  // `/` in the log: the query being typed, then the one kept (n/N), and the current match (a row of the wrapped log).
  const [searching, setSearching] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [query, setQuery] = createSignal(saved?.query ?? "");
  const [match, setMatch] = createSignal<number | null>(saved?.match ?? null);

  const bodyWidth = () => Math.max(10, dims().width - GUTTER);
  const logText = createMemo(() => {
    for (const block of sectionOf("log")?.blocks ?? []) if (block.kind === "log") return block.text;
    return null;
  });
  const rows = createMemo(() => {
    const text = logText();
    return text === null ? [] : logRows(text, bodyWidth());
  });
  const matches = createMemo(() => matchRows(rows(), query()));

  let scroll: ScrollBoxRenderable | undefined;
  let logNode: TextRenderable | undefined;
  const boxes = new Map<SectionId, BoxRenderable>();

  onMount(() => {
    // Back where the user left it, once the content is laid out.
    if (saved && scroll) scroll.afterLayout(() => scroll?.scrollTo(saved.scroll));
  });
  onCleanup(() => {
    savedOf(ui).set(ref(), { folds: folds(), selected: selectedId(), scroll: scroll?.scrollTop ?? 0, query: query(), match: match() });
  });

  /** Where the sections are now, in rows of the scrolled content. */
  const geometry = (): Geometry | null => {
    if (!scroll) return null;
    const top = scroll.content.screenY;
    const nodes = ids().map((id) => boxes.get(id));
    if (nodes.some((n) => !n)) return null;
    const starts = nodes.map((n) => n!.screenY - top);
    return { starts, ends: nodes.map((n, i) => starts[i]! + Math.max(1, n!.height) - 1), viewport: scroll.viewport.height, total: scroll.scrollHeight };
  };
  const place = (): Place => ({ selected: selected(), scroll: scroll?.scrollTop ?? 0 });
  const apply = (next: Place) => {
    const id = ids()[next.selected];
    if (id) setSelectedId(id);
    scroll?.scrollTo(next.scroll);
  };
  const move = (by: number, times = 1) => {
    const g = geometry();
    if (!g) return;
    let at = place();
    for (let i = 0; i < times; i++) at = moveInRun(g, at, by);
    apply(at);
  };
  /** After a fold changes, once the new layout is known: show the selected section. */
  const revealSoon = () =>
    scroll?.afterLayout(() => {
      const g = geometry();
      if (g) apply({ selected: selected(), scroll: reveal(g, place()) });
    });
  const select = (index: number) => {
    const id = ids()[Math.max(0, Math.min(ids().length - 1, index))];
    if (!id) return;
    setSelectedId(id);
    const g = geometry();
    if (g) apply({ selected: selected(), scroll: reveal(g, place()) });
  };
  const toggle = (id: SectionId) => {
    const section = sectionOf(id);
    if (!section) return;
    setSelectedId(id);
    setFolds((f) => ({ ...f, [id]: !isOpen(section) }));
    revealSoon();
  };
  const foldAll = (open: boolean) => {
    setFolds(Object.fromEntries(ids().map((id) => [id, open])));
    revealSoon();
  };

  /** Scrolls to a row of the log (opening it), with some context above. */
  const goToMatch = (row: number) => {
    setMatch(row);
    setSelectedId("log");
    setFolds((f) => ({ ...f, log: true }));
    scroll?.afterLayout(() => {
      if (!scroll || !logNode) return;
      const at = logNode.screenY - scroll.content.screenY + row;
      const view = scroll.viewport.height;
      if (at < scroll.scrollTop || at >= scroll.scrollTop + view) scroll.scrollTo(Math.max(0, at - Math.floor(view / 3)));
    });
  };
  const findNext = (direction: 1 | -1) => {
    if (query() === "") return ui.toast(`no search yet: ${keyHint(app.config.keymap, "search_log") ?? "/"} searches the log`);
    const row = nextMatch(matches(), match() ?? (direction > 0 ? -1 : rows().length), direction);
    if (row === null) return ui.toast(`no match for "${query()}" in the log`);
    goToMatch(row);
  };

  // While typing a search, every key goes to it (the view's keys wait); Ctrl-C still quits.
  onCleanup(
    app.keymap.intercept(
      "key",
      (ctx) => {
        if (!searching() || ui.modal()) return;
        ctx.consume();
        const { name, sequence, ctrl, meta } = ctx.event;
        if (name === "escape") setSearching(false);
        else if (name === "return") {
          setSearching(false);
          setQuery(draft());
          setMatch(null);
          if (draft() !== "") findNext(1);
        } else if (name === "backspace") setDraft((d) => d.slice(0, -1));
        else if (!ctrl && !meta && sequence.length > 0 && !/[\x00-\x1f\x7f]/.test(sequence)) setDraft((d) => d + sequence);
      },
      { priority: 40 },
    ),
  );

  const target = () => {
    const m = model();
    return m ? { kind: "run" as const, run: m.target } : null;
  };
  const halfPage = () => Math.max(1, Math.floor((scroll?.viewport.height ?? dims().height) / 2));

  useViewKeys(props.keys, {
    back: () => {
      // An error stays until dismissed, and <Esc> is back here: dismiss it first.
      if (ui.toasts().some((t) => t.error)) return ui.dismiss();
      ui.pop();
    },
    down: (n) => move(1, n),
    up: (n) => move(-1, n),
    first: () => move(Number.NEGATIVE_INFINITY),
    last: () => move(Number.POSITIVE_INFINITY),
    half_page_down: () => move(halfPage()),
    half_page_up: () => move(-halfPage()),
    next_section: () => select(selected() + 1),
    prev_section: () => select(selected() - 1),
    toggle_section: () => {
      const id = ids()[selected()];
      if (id) toggle(id);
    },
    open_sections: () => foldAll(true),
    fold_sections: () => foldAll(false),
    attach: () => void actions.attach(target()),
    retry: () => actions.retry(target()),
    run_now: () => actions.runNow(target()),
    close_session: () => actions.closeSession(target()),
    go_to_task: () => {
      const m = model();
      if (m) ui.push({ view: "task", params: { id: m.run.task_id } });
    },
    open_output: () => {
      const path = model()?.outputPath;
      if (!path) return void ui.toast("this run has no output file");
      void actions.openInPager(path);
    },
    copy_ref: () => actions.copy(model()?.ref ?? ref(), "ref"),
    copy_summary: () => {
      const summary = model()?.summary;
      if (!summary) return void ui.toast("this run has no summary to copy");
      actions.copy(summary, "summary");
    },
    search_log: () => {
      if (logText() === null) return void ui.toast("this run has no log to search");
      setDraft("");
      setSearching(true);
    },
    next_match: () => void findNext(1),
    prev_match: () => void findNext(-1),
  });

  const attachKey = () => keyHint(app.config.keymap, "attach");

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1}>
      <Switch>
        <Match when={loaded().error}>
          {(error: Accessor<string>) => (
            <box flexDirection="column" paddingTop={1}>
              <Line segments={[{ text: ref(), color: "bold" }]} />
              <Line segments={[{ text: error(), color: "red" }]} wrap />
            </box>
          )}
        </Match>
        <Match when={model()}>
          {(m: Accessor<RunModel>) => (
            <box flexDirection="column" flexGrow={1}>
              <box flexShrink={0}>
                <Line segments={runTitle(m().run, m().ref, store.now())} />
              </box>
              <Show when={m().blocked}>
                <box border borderStyle="rounded" borderColor={theme.magenta} paddingLeft={1} flexShrink={0} marginRight={1}>
                  <Line segments={[{ text: "Waiting for you. ", color: "magenta" }, ...(attachKey() ? [{ text: attachKey()!, color: "yellow" as const }, { text: " attach to its session" }] : [])]} />
                </box>
              </Show>
              <scrollbox ref={scroll} flexGrow={1} marginTop={1} scrollY scrollX={false}>
                <For each={ids()}>
                  {(id, index) => {
                    const section = () => sectionOf(id);
                    const open = () => {
                      const s = section();
                      return s ? isOpen(s) : false;
                    };
                    // A blank line before an open section, and after one, sets it apart; folded ones stack.
                    const apart = () => {
                      const i = index();
                      if (i === 0) return false;
                      const before = sectionOf(ids()[i - 1]!);
                      return open() || (before ? isOpen(before) : false);
                    };
                    onCleanup(() => boxes.delete(id));
                    return (
                      <box ref={(node: BoxRenderable) => boxes.set(id, node)} flexDirection="column" flexShrink={0} marginTop={apart() ? 1 : 0} paddingRight={1}>
                        <Show when={section()}>
                          {(s: Accessor<RunSection>) => (
                            <>
                              <box height={1} flexShrink={0} onMouseDown={(e: MouseEvent) => e.button === 0 && toggle(id)}>
                                <Line segments={heading(s(), open(), bodyWidth())} inverse={index() === selected()} bold={open() && index() !== selected()} />
                              </box>
                              <Show when={open()}>
                                <Index each={s().blocks}>
                                  {(block) => (
                                    <BlockView
                                      block={block()}
                                      run={m()}
                                      timezone={tz()}
                                      rows={rows()}
                                      matches={matches()}
                                      match={match()}
                                      onLog={(node) => (logNode = node)}
                                    />
                                  )}
                                </Index>
                              </Show>
                            </>
                          )}
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </scrollbox>
              <Show when={searching() || query() !== ""}>
                <box flexShrink={0}>
                  <Line segments={searchLine(searching() ? draft() : query(), searching(), matches(), match())} />
                </box>
              </Show>
            </box>
          )}
        </Match>
      </Switch>
    </box>
  );
}

/** `▾ Result · extra ────`: the line a section starts with. */
function heading(section: RunSection, open: boolean, width: number): Segment[] {
  const head = `${open ? "▾" : "▸"} ${section.name}${section.extra ? ` · ${section.extra}` : ""} `;
  return [{ text: fitText(head + "─".repeat(Math.max(0, width - Bun.stringWidth(head))), width) }];
}

function searchLine(text: string, typing: boolean, matches: readonly number[], match: number | null): Segment[] {
  const where = matches.length === 0 ? (text === "" || typing ? "" : "  no match") : `  ${match === null ? "-" : matches.indexOf(match) + 1} of ${matches.length}`;
  return [{ text: `/${text}`, color: "yellow" }, ...(typing ? [{ text: "█" }] : []), { text: where, color: "dim" }];
}

function BlockView(props: { block: Block; run: RunModel; timezone: string; rows: readonly string[]; matches: readonly number[]; match: number | null; onLog(node: TextRenderable): void }) {
  const { theme, store } = useApp();
  return (
    <Switch>
      <Match when={props.block.kind === "facts"}>
        <box flexShrink={0} marginBottom={1}>
          <Line segments={resultFacts(props.run.run, props.timezone, store.now())} wrap />
        </box>
      </Match>
      <Match when={props.block.kind === "markdown" && props.block}>
        {(b: Accessor<Extract<Block, { kind: "markdown" }>>) => <markdown content={b().text} syntaxStyle={theme.syntax} fg={theme.fg} bg={theme.bg} conceal flexShrink={0} />}
      </Match>
      <Match when={props.block.kind === "code" && props.block}>
        {(b: Accessor<Extract<Block, { kind: "code" }>>) => <code content={b().text} filetype={b().filetype} syntaxStyle={theme.syntax} fg={theme.fg} bg={theme.bg} wrapMode="char" flexShrink={0} />}
      </Match>
      <Match when={props.block.kind === "lines" && props.block}>
        {(b: Accessor<Extract<Block, { kind: "lines" }>>) => <For each={b().lines}>{(line) => <Line segments={line.length > 0 ? line : [{ text: "" }]} wrap />}</For>}
      </Match>
      <Match when={props.block.kind === "log"}>
        <text ref={props.onLog} fg={theme.fg} bg={theme.bg} wrapMode="none" flexShrink={0}>
          <For each={logSegments(props.rows, props.matches, props.match)}>
            {(segment) => (
              <span style={{ fg: segment.color === "yellow" ? theme.yellow : theme.fg, bg: theme.bg, inverse: segment.color === "inverse" }}>{segment.text}</span>
            )}
          </For>
        </text>
      </Match>
    </Switch>
  );
}

/** One run, opened with `ui.push({ view: "run", params: { ref } })`. */
export const RUN_VIEW: ViewDef = { keys: RUN_KEYS, component: RunDetail };
