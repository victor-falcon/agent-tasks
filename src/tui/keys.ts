// Raw stdin bytes → key names. Printable characters stay as they are
// (`j`, `G`, `/`); the rest get a name (`up`, `enter`, `ctrl-c`…).

export type Key = string;

const CSI_KEYS: Record<string, Key> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shift-tab",
  "5~": "pageup",
  "6~": "pagedown",
  "1~": "home",
  "4~": "end",
  "7~": "home",
  "8~": "end",
};

const CONTROL_KEYS: Record<string, Key> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "ctrl-c",
  "\x04": "ctrl-d",
  "\x15": "ctrl-u",
  "\x06": "ctrl-f",
  "\x02": "ctrl-b",
  "\x0c": "ctrl-l",
};

/** The keys in one chunk read from a terminal in raw mode. A lone ESC is `esc`. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i]!;
    if (ch === "\x1b") {
      const next = chunk[i + 1];
      if (next === "[" || next === "O") {
        // CSI (`ESC [ … final`) or SS3 (`ESC O x`): parameters, then a final letter or `~`.
        let j = i + 2;
        while (j < chunk.length && /[0-9;]/.test(chunk[j]!)) j++;
        const body = chunk.slice(i + 2, j + 1);
        const params = body.replace(/^1;\d+/, ""); // modifiers (`1;5A`) are ignored
        keys.push(CSI_KEYS[params] ?? CSI_KEYS[body] ?? "unknown");
        i = j + 1;
        continue;
      }
      keys.push("esc");
      i++;
      continue;
    }
    const control = CONTROL_KEYS[ch];
    if (control) keys.push(control);
    else if (ch >= " ") {
      const cp = chunk.codePointAt(i)!;
      const char = String.fromCodePoint(cp);
      keys.push(char);
      i += char.length;
      continue;
    } else keys.push("unknown");
    i++;
  }
  return keys;
}
