// tui.toml's key notation: Vim's (`j`, `G`, `gg`, `<C-d>`, `<CR>`, `<C-w>j`…),
// turned into canonical keys. keymap/config.ts builds the keymap from it and
// keymap/vim.ts turns the keys into the strokes OpenTUI's keymap matches.

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

export interface Binding {
  /** As written in the config (or the default), for the help screen and hints. */
  text: string;
  keys: string[];
}
