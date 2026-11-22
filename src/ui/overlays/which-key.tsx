import type { ActiveKey } from "@opentui/keymap";
import { type Accessor, createSignal, For, onCleanup, Show } from "solid-js";
import { fitText } from "../components/cells.ts";
import { Line } from "../components/line.tsx";
import { useApp } from "../context.ts";
import { HOLD_SEQUENCE } from "../keymap/vim.ts";

// After a prefix key (`g`, `z`, `<C-w>`, or the first key of any sequence
// tui.toml binds), a small popup lists what can follow and what each does.
// The list is the keymap's own (getActiveKeys while a sequence is pending),
// so it shows the keys tui.toml set and only those that work in this view.
// It waits a moment before showing, so `gg` typed at speed never flashes it;
// once shown it holds the sequence (no timeout) until the next key: Esc, or
// any key that continues nothing, drops it (and does nothing else, as in Vim).

/** How long a half-typed sequence waits before the popup shows. */
export const WHICH_KEY_DELAY_MS = 500;

export interface WhichKeyRow {
  keys: string;
  desc: string;
}

interface Popup {
  /** The keys typed so far (`g`). */
  typed: string;
  rows: WhichKeyRow[];
  /** Width of the keys column. */
  width: number;
}

/** The rows of the popup: each key that can follow `typed`, with its command's description ("…" when it starts a longer sequence). */
export function whichKeyRows(typed: string, active: readonly Pick<ActiveKey, "display" | "continues" | "commandAttrs">[]): WhichKeyRow[] {
  const rows = active.map((key) => {
    const desc = typeof key.commandAttrs?.desc === "string" ? key.commandAttrs.desc : null;
    return { keys: `${typed}${key.display}`, desc: key.continues ? `${desc ? `${desc}, ` : ""}more keys…` : (desc ?? "") };
  });
  return rows.sort((a, b) => a.keys.localeCompare(b.keys));
}

export function WhichKey() {
  const app = useApp();
  const { keymap } = app;
  const [popup, setPopup] = createSignal<Popup | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    keymap.setData(HOLD_SEQUENCE, false);
    setPopup(null);
  };
  const show = () => {
    const sequence = keymap.getPendingSequence();
    if (sequence.length === 0 || app.ui.modal()) return hide();
    const typed = sequence.map((p) => p.display).join("");
    const rows = whichKeyRows(typed, keymap.getActiveKeys({ includeMetadata: true }));
    if (rows.length === 0) return hide();
    keymap.setData(HOLD_SEQUENCE, true);
    setPopup({ typed, rows, width: Math.max(...rows.map((r) => Bun.stringWidth(r.keys))) });
  };

  onCleanup(
    keymap.on("pendingSequence", (sequence) => {
      if (sequence.length === 0) return hide();
      // Already open (a longer sequence, `<C-w>` then…): follow it at once.
      if (popup() !== null) return show();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        show();
      }, WHICH_KEY_DELAY_MS);
    }),
  );
  onCleanup(hide);

  return (
    <Show when={popup()}>
      {(open: Accessor<Popup>) => (
        <box
          position="absolute"
          left={1}
          bottom={1}
          zIndex={60}
          border
          borderStyle="rounded"
          borderColor={app.theme.border}
          backgroundColor={app.theme.bg}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="column"
          title={` ${open().typed}… `}
          titleAlignment="left"
        >
          <For each={open().rows}>{(row) => <Line segments={[{ text: fitText(row.keys, open().width), color: "yellow" }, { text: "  " }, { text: row.desc }]} />}</For>
          <Line segments={[{ text: "<Esc> or another key cancels", color: "dim" }]} />
        </box>
      )}
    </Show>
  );
}
