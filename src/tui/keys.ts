import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../errors.ts";

// Key bindings of the dashboard (`agent-tasks top`, and `runner` on a
// terminal). Keys are written in Vim notation (`j`, `G`, `gg`, `<C-d>`,
// `<CR>`, `<C-w>j`…) and can be changed in `<config dir>/tui.toml`:
//
//   [keys]
//   down = ["j", "<Down>"]
//   retry = "r"
//
// Setting an action replaces its default keys; an empty list unbinds it.

/** What a key can do, by view. `quit` and `help` work everywhere except where noted. */
export const ACTIONS = {
  down: "Move down / scroll down",
  up: "Move up / scroll up",
  first: "Go to the first row / the top",
  last: "Go to the last row / the bottom",
  half_page_down: "Half a page down",
  half_page_up: "Half a page up",
  next_panel: "Next panel",
  prev_panel: "Previous panel",
  open: "Open the selected run",
  back: "Close the run (back to the panels)",
  next_section: "Next section of the run",
  prev_section: "Previous section of the run",
  toggle_section: "Fold or open the selected section of the run",
  open_sections: "Open every section of the run",
  fold_sections: "Fold every section of the run",
  attach: "Attach to the run's session",
  retry: "Retry the run (failed, timed out or missed)",
  run_now: "Run the task now",
  toggle_pause: "Pause or resume the task",
  refresh: "Reload everything now",
  help: "Show the keys",
  quit: "Quit",
} as const;

export type Action = keyof typeof ACTIONS;

export type View = "list" | "detail";

/** The actions each view listens to. In a run, `back` takes the place of `quit`. */
export const VIEW_ACTIONS: Record<View, readonly Action[]> = {
  list: ["down", "up", "first", "last", "half_page_down", "half_page_up", "next_panel", "prev_panel", "open", "attach", "retry", "run_now", "toggle_pause", "refresh", "help", "quit"],
  detail: ["down", "up", "first", "last", "half_page_down", "half_page_up", "back", "next_section", "prev_section", "toggle_section", "open_sections", "fold_sections", "attach", "retry", "run_now", "toggle_pause", "refresh", "help"],
};

export const DEFAULT_KEYS: Record<Action, readonly string[]> = {
  down: ["j", "<Down>"],
  up: ["k", "<Up>"],
  first: ["gg", "<Home>"],
  last: ["G", "<End>"],
  half_page_down: ["<C-d>", "<PageDown>"],
  half_page_up: ["<C-u>", "<PageUp>"],
  next_panel: ["<Tab>", "<C-w>j"],
  prev_panel: ["<S-Tab>", "<C-w>k"],
  open: ["<CR>", "l"],
  back: ["<Esc>", "h", "q"],
  next_section: ["}"],
  prev_section: ["{"],
  toggle_section: ["<CR>", "<Space>", "za"],
  open_sections: ["zR"],
  fold_sections: ["zM"],
  attach: ["a"],
  retry: ["r"],
  run_now: ["R"],
  toggle_pause: ["p"],
  refresh: ["<C-l>"],
  help: ["?"],
  quit: ["q"],
};

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

/** Special keys, by their canonical Vim name. */
const SPECIAL = ["CR", "Esc", "Tab", "S-Tab", "BS", "Space", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Del"] as const;

/** Other spellings Vim accepts, lowercased. */
const ALIASES: Record<string, string> = {
  enter: "CR",
  return: "CR",
  cr: "CR",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  "s-tab": "S-Tab",
  bs: "BS",
  backspace: "BS",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  del: "Del",
  delete: "Del",
};

/**
 * Splits a binding into canonical keys: `gg` → [`g`, `g`], `<C-w>j` →
 * [`<C-w>`, `j`], `<cr>` → [`<CR>`]. Throws on a key it does not know.
 */
export function parseKeys(binding: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < binding.length) {
    const ch = binding[i]!;
    if (ch === "<") {
      const end = binding.indexOf(">", i);
      if (end === -1) {
        if (binding.length - i === 1) {
          keys.push("<"); // a lone `<` at the end
          i++;
          continue;
        }
        throw new Error(`"${binding}": "<" without a closing ">" (write <lt> for the < key)`);
      }
      keys.push(canonicalSpecial(binding.slice(i + 1, end), binding));
      i = end + 1;
      continue;
    }
    if (ch === " ") throw new Error(`"${binding}": write <Space> for the space bar`);
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) throw new Error(`"${binding}": control characters are written like <C-d>`);
    const char = String.fromCodePoint(code);
    keys.push(char);
    i += char.length;
  }
  if (keys.length === 0) throw new Error("empty key");
  return keys;
}

function canonicalSpecial(name: string, binding: string): string {
  const lower = name.toLowerCase();
  if (lower === "lt") return "<";
  if (lower === "gt") return ">";
  const ctrl = /^c-(.)$/i.exec(name);
  if (ctrl) {
    const key = ctrl[1]!.toLowerCase();
    if (!/[a-z]/.test(key)) throw new Error(`"${binding}": only <C-a> to <C-z> are supported`);
    return `<C-${key}>`;
  }
  const special = ALIASES[lower];
  if (special) return `<${special}>`;
  throw new Error(`"${binding}": unknown key <${name}> (known: ${SPECIAL.map((s) => `<${s}>`).join(", ")}, <C-a>…<C-z>)`);
}

/**
 * Splits terminal input (raw mode) into canonical keys. Arrow keys and other
 * escape sequences become one key; a lone ESC is `<Esc>`.
 */
export function decodeKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === "\x1b") {
      const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(data.slice(i));
      if (seq) {
        const key = ESCAPES[seq[0].slice(1)];
        if (key) keys.push(key);
        i += seq[0].length;
        continue;
      }
      keys.push("<Esc>");
      i++;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (ch === "\r" || ch === "\n") keys.push(ch === "\r" ? "<CR>" : "<C-j>");
    else if (ch === "\t") keys.push("<Tab>");
    else if (code === 0x7f || code === 0x08) keys.push("<BS>");
    else if (ch === " ") keys.push("<Space>");
    else if (code >= 1 && code <= 26) keys.push(`<C-${String.fromCharCode(code + 96)}>`);
    else if (code >= 0x20) keys.push(String.fromCodePoint(code));
    i += code > 0xffff ? 2 : 1;
  }
  return keys;
}

const ESCAPES: Record<string, string> = {
  "[A": "<Up>",
  "[B": "<Down>",
  "[C": "<Right>",
  "[D": "<Left>",
  OA: "<Up>",
  OB: "<Down>",
  OC: "<Right>",
  OD: "<Left>",
  "[H": "<Home>",
  "[F": "<End>",
  OH: "<Home>",
  OF: "<End>",
  "[1~": "<Home>",
  "[4~": "<End>",
  "[7~": "<Home>",
  "[8~": "<End>",
  "[3~": "<Del>",
  "[5~": "<PageUp>",
  "[6~": "<PageDown>",
  "[Z": "<S-Tab>",
};

// ---------------------------------------------------------------------------
// The keymap
// ---------------------------------------------------------------------------

export interface Binding {
  /** As written in the config (or the default), for the help screen and hints. */
  text: string;
  keys: string[];
}

export type Keymap = Record<Action, Binding[]>;

export const TUI_CONFIG_FILE = "tui.toml";

/** Bindings that can't be used; `loadKeymap` reports them as a config error of tui.toml. */
export class KeymapError extends Error {
  constructor(readonly details: string[]) {
    super(`invalid key bindings: ${details.join("; ")}`);
  }
}

function bindingsOf(texts: readonly string[]): Binding[] {
  return texts.map((text) => ({ text, keys: parseKeys(text) }));
}

/** The default keymap with `overrides` applied (action → key or list of keys), checked for conflicts. */
export function buildKeymap(overrides: Record<string, unknown> = {}): Keymap {
  const errors: string[] = [];
  const keymap = Object.fromEntries(Object.entries(DEFAULT_KEYS).map(([a, texts]) => [a, bindingsOf(texts)])) as Keymap;
  for (const [action, value] of Object.entries(overrides)) {
    if (!(action in ACTIONS)) {
      errors.push(`keys.${action}: unknown action (known: ${Object.keys(ACTIONS).join(", ")})`);
      continue;
    }
    const texts = typeof value === "string" ? [value] : Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
    if (texts === null) {
      errors.push(`keys.${action}: expected a key or a list of keys, e.g. "j" or ["j", "<Down>"]`);
      continue;
    }
    try {
      keymap[action as Action] = bindingsOf(texts);
    } catch (err) {
      errors.push(`keys.${action}: ${(err as Error).message}`);
    }
  }
  if (errors.length === 0) errors.push(...conflicts(keymap));
  if (errors.length > 0) throw new KeymapError(errors);
  return keymap;
}

/** Two actions of the same view on the same keys, or one's keys a prefix of the other's (it would never fire). */
function conflicts(keymap: Keymap): string[] {
  const errors = new Set<string>();
  for (const [view, actions] of Object.entries(VIEW_ACTIONS)) {
    const all = actions.flatMap((action) => keymap[action].map((b) => ({ action, b })));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [x, y] = [all[i]!, all[j]!];
        if (x.action === y.action) continue;
        const [short, long] = x.b.keys.length <= y.b.keys.length ? [x, y] : [y, x];
        if (short.b.keys.every((k, n) => long.b.keys[n] === k)) {
          const what = short.b.keys.length === long.b.keys.length ? `"${short.b.text}" is bound to both` : `"${short.b.text}" (${short.action}) hides "${long.b.text}" (${long.action}); it is bound to`;
          errors.add(`${what} ${short.action} and ${long.action} in the ${view} view`);
        }
      }
    }
  }
  return [...errors];
}

/** Reads `<configDir>/tui.toml`; the defaults when it does not exist. */
export function loadKeymap(configDir: string): { keymap: Keymap; file: string | null } {
  const file = join(configDir, TUI_CONFIG_FILE);
  if (!existsSync(file)) return { keymap: buildKeymap(), file: null };
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(file, [`invalid TOML: ${(err as Error).message}`]);
  }
  const root = parsed as Record<string, unknown>;
  const unknown = Object.keys(root).filter((k) => k !== "keys");
  if (unknown.length > 0) throw new ConfigError(file, unknown.map((k) => `${k}: unknown setting (only [keys] is read)`));
  const keys = root.keys ?? {};
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) throw new ConfigError(file, ["keys: must be a table, e.g. [keys]"]);
  try {
    return { keymap: buildKeymap(keys as Record<string, unknown>), file };
  } catch (err) {
    if (err instanceof KeymapError) throw new ConfigError(file, err.details);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Matching key sequences
// ---------------------------------------------------------------------------

export type MatchResult = { kind: "action"; action: Action } | { kind: "pending" } | { kind: "none" };

/**
 * Turns keys into actions for one view, waiting while the keys typed so far
 * start a longer binding (`g` of `gg`). Like Vim, a sequence that matches
 * nothing is dropped.
 */
export class KeyMatcher {
  private pending: string[] = [];

  constructor(private readonly keymap: Keymap) {}

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  get pendingText(): string {
    return this.pending.join("");
  }

  reset(): void {
    this.pending = [];
  }

  feed(key: string, view: View): MatchResult {
    this.pending.push(key);
    const typed = this.pending;
    let exact: Action | null = null;
    let longer = false;
    for (const action of VIEW_ACTIONS[view]) {
      for (const b of this.keymap[action]) {
        if (b.keys.length < typed.length || !typed.every((k, i) => b.keys[i] === k)) continue;
        if (b.keys.length === typed.length) exact = action;
        else longer = true;
      }
    }
    if (exact) {
      this.pending = [];
      return { kind: "action", action: exact };
    }
    if (longer) return { kind: "pending" };
    this.pending = [];
    return { kind: "none" };
  }
}

/** The first key of each action, for the footer: `j/k`. */
export function keyHint(keymap: Keymap, action: Action): string | null {
  return keymap[action][0]?.text ?? null;
}
