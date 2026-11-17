import { visibleWidth } from "../output/table.ts";

// Text that fits the screen: escape sequences and control characters out of
// captured logs, long lines wrapped, styled lines cut at the width.

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;

/** Plain text from captured output: no escape sequences, no carriage returns, tabs as spaces. */
export function sanitize(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      // A carriage return redraws the line: keep what was written last.
      const cr = line.lastIndexOf("\r");
      const last = cr === -1 ? line : line.slice(cr + 1);
      return last.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    })
    .join("\n");
}

/** Plain text (no escapes) split into lines of at most `width` columns. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  for (const line of text.split("\n")) {
    if (visibleWidth(line) <= w) {
      out.push(line);
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const ch of line) {
      const chWidth = visibleWidth(ch);
      if (currentWidth + chWidth > w) {
        out.push(current);
        current = "";
        currentWidth = 0;
      }
      current += ch;
      currentWidth += chWidth;
    }
    out.push(current);
  }
  return out;
}

const ESCAPE_AT = /^\x1b\[[0-9;]*m/;

/**
 * A styled line cut to `width` visible columns (with `…` when cut) and
 * padded with spaces to exactly `width`. Color codes don't count and are
 * closed at the end.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const full = visibleWidth(text);
  if (full <= width) return text + " ".repeat(width - full);
  let out = "";
  let used = 0;
  let i = 0;
  let styled = false;
  while (i < text.length) {
    const esc = ESCAPE_AT.exec(text.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      styled = true;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const chWidth = visibleWidth(ch);
    if (used + chWidth > width - 1) break;
    out += ch;
    used += chWidth;
    i += ch.length;
  }
  return `${out}…${styled ? "\x1b[0m" : ""}${" ".repeat(Math.max(0, width - used - 1))}`;
}
