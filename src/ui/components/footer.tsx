import { createSignal, onCleanup } from "solid-js";
import { useApp } from "../context.ts";
import { keyHint, type Keymap } from "../keymap/config.ts";
import type { Hint } from "../keymap/spec.ts";
import { viewOf } from "../views/registry.tsx";
import type { Segment } from "./cells.ts";
import { Line } from "./line.tsx";

// The bottom line: the keys that work in the current view (their first key
// in tui.toml, so a remapped key shows as remapped), then on the right the
// keys typed so far of a longer binding (`g…`) or of a count (`15…`) and a
// spinner while a command runs in the background.

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;

export function hintText(keymap: Keymap, hints: readonly Hint[]): string {
  return hints
    .map(({ actions, label }) => {
      const keys = actions.map((a) => keyHint(keymap, a)).filter((k) => k !== null);
      return keys.length > 0 ? `${keys.join("/")} ${label}` : null;
    })
    .filter((h) => h !== null)
    .join(" · ");
}

export function Footer() {
  const app = useApp();
  const [pending, setPending] = createSignal("");
  const [frame, setFrame] = createSignal(0);
  onCleanup(app.keymap.on("pendingSequence", (sequence) => setPending(sequence.map((part) => part.display).join(""))));
  const spin = setInterval(() => app.ui.busy().length > 0 && setFrame((f) => (f + 1) % SPINNER.length), SPINNER_MS);
  onCleanup(() => clearInterval(spin));

  const left = (): Segment[] => [{ text: hintText(app.config.keymap, viewOf(app.ui.route()).keys.hints), color: "dim" }];
  const right = (): Segment[] => {
    const out: Segment[] = [];
    const typed = app.count.typed() + pending();
    if (typed) out.push({ text: `${typed}… `, color: "yellow" });
    const busy = app.ui.busy();
    if (busy.length > 0) out.push({ text: `${SPINNER[frame()]} ${busy.at(-1)!.text}${busy.length > 1 ? ` (+${busy.length - 1})` : ""}`, color: "cyan" });
    const error = app.store.loadError();
    if (error) out.push({ text: ` could not reload: ${error}`, color: "red" });
    return out;
  };
  return (
    <box flexDirection="row" height={1} flexShrink={0} justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <Line segments={left()} />
      <Line segments={right()} />
    </box>
  );
}
