import type { Style } from "./style.ts";

// Aligned columns. Widths ignore color codes and count wide characters right.

export function visibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export interface TableOptions {
  /** Prefix for every line (e.g. two spaces inside a section). */
  indent?: string;
  /** Style used to dim the header row; omit for no header styling. */
  style?: Style;
  /** False to print the rows without the first one as a header. */
  header?: boolean;
}

/** The first row is the header (unless `header: false`). The last column is never padded. */
export function renderTable(rows: readonly (readonly string[])[], { indent = "", style, header = true }: TableOptions = {}): string {
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) => Math.max(...rows.map((r) => visibleWidth(r[i] ?? ""))));
  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, i) => (i === row.length - 1 ? cell : padEnd(cell, widths[i]!)))
        .join("  ")
        .trimEnd();
      return indent + (header && rowIndex === 0 && style ? style.paint("dim", line) : line);
    })
    .join("\n");
}

/** One line, at most `max` characters, with `…` when cut. */
export function truncate(text: string, max: number): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const oneLine = text.includes("\n") && line !== text.trim() ? `${line} …` : line;
  if (visibleWidth(oneLine) <= max) return oneLine;
  let out = "";
  for (const ch of oneLine) {
    if (visibleWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}
