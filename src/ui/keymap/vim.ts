import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { BindingParser, KeyStrokeInput, Keymap } from "@opentui/keymap";
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields, registerNeovimDisambiguation } from "@opentui/keymap/addons";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import { parseKeys } from "../../tui/keys.ts";

// tui.toml's Vim notation on @opentui/keymap: `gg`, `G`, `<C-d>`, `<CR>`,
// `<C-w>j`… become key strokes the way the terminal reports them (`G` is
// shift+g, `<CR>` is return), and `{count}j` takes a count. Bindings come
// from tui.toml already checked by parseKeys, so this parser never sees an
// invalid key.

export type AppKeymap = Keymap<Renderable, KeyEvent>;

/** Vim's `timeoutlen`: how long a key that starts a longer binding waits for the rest. */
export const SEQUENCE_TIMEOUT_MS = 1000;
/** How long a key that is a binding *and* starts a longer one (`1` and `12j`) waits before running alone. */
export const AMBIGUOUS_TIMEOUT_MS = 400;

const SPECIAL_NAMES: Record<string, string> = {
  CR: "return",
  Esc: "escape",
  Tab: "tab",
  BS: "backspace",
  Space: "space",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Del: "delete",
};

/** A canonical key of parseKeys (`g`, `G`, `<C-d>`, `<S-Tab>`, `<CR>`) as the stroke the terminal sends. */
export function strokeOf(key: string): KeyStrokeInput {
  if (key.length > 2 && key.startsWith("<") && key.endsWith(">")) {
    const name = key.slice(1, -1);
    const ctrl = /^C-(.)$/.exec(name);
    if (ctrl) return { name: ctrl[1]!, ctrl: true };
    if (name === "S-Tab") return { name: "tab", shift: true };
    const special = SPECIAL_NAMES[name];
    if (special) return { name: special };
  }
  if (/^[A-Z]$/.test(key)) return { name: key.toLowerCase(), shift: true };
  return { name: key };
}

/** Length of the first key written at `index` (`<C-d>` is 5, `g` is 1). */
function keyLength(input: string, index: number): number {
  if (input[index] === "<") {
    const end = input.indexOf(">", index);
    if (end > index + 1) return end - index + 1;
  }
  return String.fromCodePoint(input.codePointAt(index)!).length;
}

/** Parses one key of Vim notation at a time; `{count}` is left to the default parser. */
const vimParser: BindingParser = (ctx) => {
  const { input, index } = ctx;
  if (input[index] === "{") return undefined;
  const length = keyLength(input, index);
  const text = input.slice(index, index + length);
  const [key] = parseKeys(text);
  return { parts: [ctx.parseObjectKey(strokeOf(key!), { display: key! })], nextIndex: index + length };
};

/** A count before a motion (`5j`): one to four digits, not starting with 0. */
function registerCount(keymap: AppKeymap): void {
  keymap.registerSequencePattern({
    name: "count",
    min: 1,
    max: 4,
    match(event) {
      if (event.ctrl || event.meta || !/^[0-9]$/.test(event.name)) return undefined;
      return { value: event.name };
    },
    finalize: (values) => {
      const n = Number((values as string[]).join(""));
      return n > 0 ? n : 1;
    },
  });
}

/** Forgets a half-typed sequence (`g` of `gg`) after a while, like Vim. */
function registerSequenceTimeout(keymap: AppKeymap): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = keymap.on("pendingSequence", (sequence) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (sequence.length > 0) timer = setTimeout(() => keymap.clearPendingSequence(), SEQUENCE_TIMEOUT_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    off();
  };
}

/** The app's keymap on `renderer`: Vim notation, counts, `enabled` layers, sequence timeouts. */
export function createAppKeymap(renderer: CliRenderer): AppKeymap {
  const keymap = createOpenTuiKeymap(renderer);
  registerDefaultKeys(keymap);
  keymap.prependBindingParser(vimParser);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  registerNeovimDisambiguation(keymap, { timeoutMs: AMBIGUOUS_TIMEOUT_MS });
  registerCount(keymap);
  const offTimeout = registerSequenceTimeout(keymap);
  renderer.once("destroy", offTimeout);
  return keymap;
}

/** `{count}j`: the counted form of a single-key binding, or null for a sequence (`gj` takes no count). */
export function countedBinding(text: string): string | null {
  return parseKeys(text).length === 1 ? `{count}${text}` : null;
}
