import { visibleWidth } from "../output/table.ts";

// Text that fits the screen: escape sequences and control characters out of
// captured logs, long lines wrapped.

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

/**
 * Plain text (no escapes) split into lines of at most `width` columns,
 * between words when it can (a word longer than a line is cut).
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(1, width);
  for (const line of text.split("\n")) {
    if (visibleWidth(line) <= w) {
      out.push(line);
      continue;
    }
    // Continuation lines keep the line's indentation when that leaves room.
    const indent = /^ */.exec(line)![0].slice(0, w - 1);
    const hang = indent.length < w / 2 ? indent : "";
    let current = indent;
    const flush = () => {
      out.push(current.trimEnd());
      current = hang;
    };
    for (const word of line.slice(indent.length).split(/(?<= )/)) {
      if (current.trim() !== "" && visibleWidth(current + word.trimEnd()) > w) flush();
      for (const ch of word) {
        // Only a word longer than a whole line gets here with no room.
        if (current.trim() !== "" && visibleWidth(current + ch) > w && ch !== " ") flush();
        current += ch;
      }
    }
    if (current.trim() !== "") out.push(current.trimEnd());
  }
  return out;
}
