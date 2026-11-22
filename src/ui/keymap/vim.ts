import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { BindingParser, KeyStrokeInput, Keymap } from "@opentui/keymap";
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields, registerNeovimDisambiguation } from "@opentui/keymap/addons";
import { createOpenTuiKeymap } from "@opentui/keymap/opentui";
import { parseKeys } from "./notation.ts";
import type { Action } from "./actions.ts";
import type { Keymap as TuiKeymap } from "./config.ts";

// tui.toml's Vim notation on @opentui/keymap: `gg`, `G`, `<C-d>`, `<CR>`,
// `<C-w>j`… become key strokes the way the terminal reports them (`G` is
// shift+g, `<CR>` is return). Bindings come from tui.toml already checked by
// parseKeys, so this parser never sees an invalid key. Counts (`15j`) are
// not the keymap's: see count.ts.

export type AppKeymap = Keymap<Renderable, KeyEvent>;

/** Vim's `timeoutlen`: how long a key that starts a longer binding waits for the rest. */
export const SEQUENCE_TIMEOUT_MS = 1000;
/** How long a key that is a binding *and* starts a longer one (`1` and `12j`, see count.ts) waits before running alone. */
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

/** Parses one key of Vim notation at a time. */
const vimParser: BindingParser = (ctx) => {
  const { input, index } = ctx;
  const length = keyLength(input, index);
  const text = input.slice(index, index + length);
  const [key] = parseKeys(text);
  return { parts: [ctx.parseObjectKey(strokeOf(key!), { display: key! })], nextIndex: index + length };
};

/**
 * Set (keymap.setData) while the which-key popup lists what can follow a
 * half-typed sequence: the sequence then waits for its next key instead of
 * timing out under the user's eyes (overlays/which-key.tsx).
 */
export const HOLD_SEQUENCE = "sequence.hold";

/** Forgets a half-typed sequence (`g` of `gg`) after a while, like Vim, unless the which-key popup holds it. */
function registerSequenceTimeout(keymap: AppKeymap): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = keymap.on("pendingSequence", (sequence) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (sequence.length > 0)
      timer = setTimeout(() => {
        if (keymap.getData(HOLD_SEQUENCE) !== true) keymap.clearPendingSequence();
      }, SEQUENCE_TIMEOUT_MS);
  });
  return () => {
    if (timer) clearTimeout(timer);
    off();
  };
}

/** The app's keymap on `renderer`: Vim notation, `enabled` layers, sequence timeouts. */
export function createAppKeymap(renderer: CliRenderer): AppKeymap {
  const keymap = createOpenTuiKeymap(renderer);
  registerDefaultKeys(keymap);
  keymap.prependBindingParser(vimParser);
  registerEnabledFields(keymap);
  registerMetadataFields(keymap);
  registerNeovimDisambiguation(keymap, { timeoutMs: AMBIGUOUS_TIMEOUT_MS });
  const offTimeout = registerSequenceTimeout(keymap);
  renderer.once("destroy", offTimeout);
  return keymap;
}

/** Whether `event` is the single key `text` of tui.toml (`j`, `G`, `<C-d>`, `<Down>`); false for a sequence (`gg`). */
export function isKey(event: KeyEvent, text: string): boolean {
  const keys = parseKeys(text);
  if (keys.length !== 1) return false;
  const stroke = strokeOf(keys[0]!);
  return event.name === stroke.name && event.ctrl === (stroke.ctrl ?? false) && event.shift === (stroke.shift ?? false) && !event.meta;
}

/** Whether `event` is a single-key binding tui.toml gives to one of `actions` (j for `down`): the first such action, or null. */
export function actionOfKey(event: KeyEvent, keymap: TuiKeymap, actions: readonly Action[]): Action | null {
  return actions.find((action) => keymap[action].some((b) => isKey(event, b.text))) ?? null;
}
