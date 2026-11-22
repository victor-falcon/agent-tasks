import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import { fitText } from "../components/cells.ts";
import { Line } from "../components/line.tsx";
import { useApp } from "../context.ts";
import { ACTIONS, type Action } from "../keymap/actions.ts";
import type { Keymap } from "../keymap/config.ts";
import { GLOBAL_ACTIONS, type ViewKeys } from "../keymap/spec.ts";
import { actionOfKey } from "../keymap/vim.ts";
import { viewOf } from "../views/registry.tsx";

// `?`: every key of the current view, grouped (moving, what this view does,
// what works everywhere), with the tui.toml in use. A long list scrolls:
// j/k, <C-d>/<C-u>, G/<Home>/<End> (the keys tui.toml gives those motions)
// and the wheel; any other key closes it. Keys are taken before the keymap
// sees them, so nothing behind the overlay runs.

/** Moving around a view: the first group, whatever the view. */
const MOVING: readonly Action[] = [
  "down",
  "up",
  "first",
  "last",
  "half_page_down",
  "half_page_up",
  "next_panel",
  "prev_panel",
  "next_section",
  "prev_section",
  "next_subtab",
  "prev_subtab",
  "toggle_section",
  "open_sections",
  "fold_sections",
  "open",
  "back",
];

const FOOTNOTE = "j/k <C-d>/<C-u> scroll · any other key closes · Ctrl-C quits";
/** Counts are typed in the views, not here (keys go to the help while it shows). */
const COUNTS = "In a view: 15j moves 15 rows; 1–4 alone switch tabs (after a moment, or at once before another key).";

export interface HelpSection {
  title: string;
  rows: { keys: string; action: Action; desc: string }[];
}

/** The view's keys in groups: Moving, This view, Everywhere (empty groups left out). */
export function helpSections(spec: ViewKeys, keymap: Keymap): HelpSection[] {
  const row = (action: Action) => ({ keys: keymap[action].map((b) => b.text).join(" ") || "(unbound)", action, desc: ACTIONS[action] });
  const moving = spec.actions.filter((a) => MOVING.includes(a));
  const everywhere = spec.actions.filter((a) => GLOBAL_ACTIONS.includes(a) && !MOVING.includes(a));
  const own = spec.actions.filter((a) => !moving.includes(a) && !everywhere.includes(a));
  return [
    { title: "Moving", rows: moving.map(row) },
    { title: "This view", rows: own.map(row) },
    { title: "Everywhere", rows: everywhere.map(row) },
  ].filter((s) => s.rows.length > 0);
}

export function Help() {
  const app = useApp();
  const dims = useTerminalDimensions();
  let scroll: ScrollBoxRenderable | undefined;
  const halfPage = () => Math.max(1, Math.floor((scroll?.viewport.height ?? 10) / 2));
  /** The motions of tui.toml that scroll the list. */
  const moves: Partial<Record<Action, () => void>> = {
    down: () => scroll?.scrollBy(1),
    up: () => scroll?.scrollBy(-1),
    half_page_down: () => scroll?.scrollBy(halfPage()),
    half_page_up: () => scroll?.scrollBy(-halfPage()),
    first: () => scroll?.scrollTo(0),
    last: () => scroll?.scrollTo(scroll.scrollHeight),
  };
  onCleanup(
    app.keymap.intercept(
      "key",
      (ctx) => {
        if (!app.ui.help()) return;
        ctx.consume();
        const move = actionOfKey(ctx.event, app.config.keymap, Object.keys(moves) as Action[]);
        if (move) moves[move]!();
        else app.ui.setHelp(false);
      },
      { priority: 50 },
    ),
  );

  const sections = () => helpSections(viewOf(app.ui.route()).keys, app.config.keymap);
  const widths = () => {
    const rows = sections().flatMap((s) => s.rows);
    const keys = Math.max(0, ...rows.map((r) => Bun.stringWidth(r.keys)));
    const action = Math.max(0, ...rows.map((r) => r.action.length));
    const line = Math.max(...rows.map((r) => keys + action + 4 + Bun.stringWidth(r.desc)), Bun.stringWidth(FOOTNOTE), Bun.stringWidth(COUNTS));
    // Padding, borders and the scrollbar around the longest line, within the terminal.
    return { keys, action, box: Math.min(line + 7, dims().width - 2) };
  };
  return (
    <Show when={app.ui.help()}>
      <box position="absolute" top={0} left={0} width="100%" height="100%" justifyContent="center" alignItems="center" zIndex={100}>
        <box
          border
          borderStyle="rounded"
          borderColor={app.theme.border}
          backgroundColor={app.theme.bg}
          paddingLeft={2}
          paddingRight={2}
          flexDirection="column"
          title=" Keys "
          titleAlignment="left"
          maxHeight={Math.max(8, dims().height - 2)}
          width={widths().box}
        >
          <Line segments={[{ text: app.config.file ? `from ${app.config.file}` : "defaults; change them in tui.toml in the config folder", color: "dim" }]} />
          <scrollbox ref={scroll} flexGrow={1} flexShrink={1} scrollY scrollX={false}>
            <For each={sections()}>
              {(section) => (
                <box flexDirection="column" flexShrink={0}>
                  <Line segments={[{ text: "" }]} />
                  <Line segments={[{ text: section.title, color: "bold" }]} />
                  <For each={section.rows}>
                    {(row) => <Line segments={[{ text: fitText(row.keys, widths().keys), color: "yellow" }, { text: "  " }, { text: fitText(row.action, widths().action), color: "dim" }, { text: "  " }, { text: row.desc }]} />}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
          <Line segments={[{ text: "" }]} />
          <Line segments={[{ text: COUNTS, color: "dim" }]} />
          <Line segments={[{ text: FOOTNOTE, color: "dim" }]} />
        </box>
      </box>
    </Show>
  );
}
