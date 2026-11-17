// Terminal escapes for the runner's full-screen view, and text helpers that
// count visible width (colors take no room, wide characters take two).

const ESC = "\x1b";

export const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[2J`; // alternate screen, hide cursor, no auto-wrap, clear
export const LEAVE_SCREEN = `${ESC}[0m${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
export const RESET = `${ESC}[0m`;

/** Moves the cursor to a 0-based row, first column, and clears the line. */
export function lineAt(row: number, text: string): string {
  return `${ESC}[${row + 1};1H${ESC}[2K${text}`;
}

const SGR = /^\x1b\[[0-9;]*m/;

/** Splits text into SGR color codes (zero width) and single characters. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      const m = SGR.exec(text.slice(i));
      if (m) {
        out.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push(ch);
    i += ch.length;
  }
  return out;
}

export function width(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * Exactly `cols` columns: cut with `…` when longer (colors kept, reset at the
 * cut), padded with spaces when shorter.
 */
export function fit(text: string, cols: number): string {
  if (cols <= 0) return "";
  const w = width(text);
  if (w <= cols) return text + " ".repeat(cols - w);
  let out = "";
  let used = 0;
  let colored = false;
  for (const t of tokens(text)) {
    if (t.startsWith(ESC)) {
      out += t;
      colored = true;
      continue;
    }
    const tw = width(t);
    if (used + tw > cols - 1) break;
    out += t;
    used += tw;
  }
  return `${out}${colored ? RESET : ""}…${" ".repeat(Math.max(0, cols - 1 - used))}`;
}

/** Left text and right text on one line of `cols` columns; the left one is cut first. */
export function spread(left: string, right: string, cols: number): string {
  const rw = width(right);
  if (rw >= cols) return fit(right, cols);
  return fit(left, cols - rw - 1) + " " + right;
}

/**
 * A line cut into pieces of at most `cols` columns, colors kept: each piece
 * ends with a reset and the next one starts with the colors still open.
 */
export function hardWrap(text: string, cols: number): string[] {
  if (cols <= 0 || width(text) <= cols) return [text];
  const out: string[] = [];
  let line = "";
  let used = 0;
  let open = ""; // SGR codes in effect, replayed at the start of the next piece
  for (const t of tokens(text)) {
    if (t.startsWith(ESC)) {
      line += t;
      open = t === RESET || t === `${ESC}[m` ? "" : open + t;
      continue;
    }
    const tw = width(t);
    if (used + tw > cols) {
      out.push(open ? line + RESET : line);
      line = open;
      used = 0;
    }
    line += t;
    used += tw;
  }
  out.push(line);
  return out;
}

/** Words wrapped to `cols` columns (no colors expected). Long words are cut. */
export function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (width(line) + 1 + width(word) <= cols) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.map((l) => (width(l) > cols ? fit(l, cols) : l));
}

/**
 * Text from an agent's screen or log, safe to draw inside the view: colors
 * are kept, every other escape (cursor moves, titles, clears) and control
 * character is dropped, tabs become spaces and a carriage return keeps what
 * was written after it.
 */
export function sanitize(text: string): string[] {
  const cleaned = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, (seq) => (/^\x1b\[[0-9;]*m$/.test(seq) ? seq : "")) // CSI: keep SGR only
    .replace(/\x1b(?!\[[0-9;]*m)[@-_]/g, ""); // other two-character escapes
  return cleaned.split("\n").map((line) => {
    const afterCr = line.slice(line.lastIndexOf("\r") + 1);
    return afterCr.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "");
  });
}
