import { reactiveMatcherFromSignal } from "@opentui/keymap/solid";
import { type Accessor, createSignal, onCleanup, Show } from "solid-js";
import { useApp } from "../context.ts";
import { keyHint } from "../keymap/config.ts";
import { Line } from "./line.tsx";

// The `/` filter of a list view, shared by every list (Tasks; Runs next): a
// line at the top of the list where the text is typed, filtering the rows
// as it changes. Enter keeps the text (shown as a chip), Esc clears it. The
// text lives in the UI state, so it is still there when the user comes back
// from a detail. While the text is typed the views' keys are off (`j` is a
// letter, not a move): the input has the keys, and this bar's own layer
// takes Enter and Esc.
//
// Using it in a list view:
//
//   const filter = useFilter("runs");                 // state kept per view
//   const rows = () => all().filter((r) => filter.matches(r.task_id, r.summary));
//   useViewKeys(props.keys, { filter: filter.open, … }); // `filter` is bound to `/`
//   <FilterBar filter={filter} />                     // above the list
//
// and list `filter` in the view's actions (views/<name>/keys.ts).

export interface Filter {
  /** The text typed so far ("" for none). */
  query: Accessor<string>;
  /** Whether the text is being typed (the bar has the keys). */
  editing: Accessor<boolean>;
  /** Replaces the text (the input does, as it is typed). */
  set(text: string): void;
  /** Starts typing (`/`), with the text kept so far. */
  open(): void;
  /** Stops typing and keeps the text (Enter). */
  keep(): void;
  /** Stops typing and drops the text (Esc). */
  clear(): void;
  /** Whether a row with these fields passes the filter (see matchesQuery). */
  matches(...fields: readonly (string | null | undefined)[]): boolean;
}

/**
 * Whether every word of `query` is in one of `fields`, ignoring case: `sen
 * fail` matches a row whose id has "sen" and whose summary has "fail". An
 * empty query matches everything.
 */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return true;
  const haystack = fields.filter((f) => f).map((f) => f!.toLowerCase());
  return words.every((w) => haystack.some((f) => f.includes(w)));
}

/** The filter of the view `view`: its text survives the view (kept in the UI state). */
export function useFilter(view: string): Filter {
  const { ui } = useApp();
  const [query, setQuery] = ui.viewState(`${view}:filter`, "");
  const [editing, setEditing] = createSignal(false);
  const stop = () => {
    setEditing(false);
    ui.setTyping(false);
  };
  // A view closed while its bar has the keys (it can't, today: the keys are the bar's) must not leave them off.
  onCleanup(() => editing() && ui.setTyping(false));
  return {
    query,
    editing,
    open() {
      setEditing(true);
      ui.setTyping(true);
    },
    keep: stop,
    clear() {
      setQuery("");
      stop();
    },
    matches: (...fields) => matchesQuery(query(), fields),
    set: setQuery,
  };
}

/** The bar: hidden with no filter; the input while typing; a chip once kept (a click edits it again). */
export function FilterBar(props: { filter: Filter }) {
  const app = useApp();
  const { theme } = app;
  const off = app.keymap.registerLayer({
    priority: 90,
    enabled: reactiveMatcherFromSignal(() => props.filter.editing()),
    commands: [
      { name: "filter.keep", desc: "Keep the filter", run: () => props.filter.keep() },
      { name: "filter.clear", desc: "Clear the filter", run: () => props.filter.clear() },
    ],
    bindings: [
      { key: "<CR>", cmd: "filter.keep" },
      { key: "<Esc>", cmd: "filter.clear" },
    ],
  });
  onCleanup(off);
  const filterKey = () => keyHint(app.config.keymap, "filter") ?? "/";

  return (
    <Show when={props.filter.editing() || props.filter.query() !== ""}>
      <box flexDirection="row" height={1} flexShrink={0} paddingLeft={2}>
        <Show
          when={props.filter.editing()}
          fallback={
            <box flexDirection="row" height={1} onMouseDown={() => props.filter.open()}>
              <Line segments={[{ text: ` ${filterKey()} ${props.filter.query()} `, color: "inverse" }]} />
              <box height={1} onMouseDown={(e) => (e.stopPropagation(), props.filter.clear())}>
                <Line segments={[{ text: " ×", color: "dim" }]} />
              </box>
              <Line segments={[{ text: `  ${filterKey()} edit · <Esc> clear`, color: "dim" }]} />
            </box>
          }
        >
          <Line segments={[{ text: `${filterKey()} `, color: "yellow" }]} />
          <input
            flexGrow={1}
            value={props.filter.query()}
            focused
            onInput={(value: string) => props.filter.set(value)}
            textColor={theme.fg}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            focusedTextColor={theme.fg}
            cursorColor={theme.fg}
          />
          <Line segments={[{ text: "  ⏎ keep · <Esc> clear", color: "dim" }]} />
        </Show>
      </box>
    </Show>
  );
}
