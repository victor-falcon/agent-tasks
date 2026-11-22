import type { Color } from "../../output/style.ts";

// Rows of cells in aligned columns, cut to a width: the text of a list row.
// Pure, so column layout is tested without a renderer.

export interface Segment {
  text: string;
  color?: Color;
  /** A cell in more than one color (a strip of results `■■✕`): its pieces, whose texts make up `text`. */
  parts?: readonly Segment[];
}

const GAP = "  ";
const width = (text: string) => Bun.stringWidth(text);

/** Width of each column across `rows` (columns that are empty in every row get 0 and are skipped). */
export function columnWidths(rows: readonly (readonly Segment[])[]): number[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell.text))));
  return widths;
}

/** One row as segments: cells padded to their column, two spaces apart, cut to `max` columns with `…`. */
export function alignRow(cells: readonly Segment[], widths: readonly number[], max: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  const last = widths.reduce((at, w, i) => (w > 0 ? i : at), -1);
  for (let i = 0; i < cells.length; i++) {
    if ((widths[i] ?? 0) === 0) continue;
    const cell = cells[i]!;
    const padded = i === last ? cell.text : cell.text + " ".repeat(widths[i]! - width(cell.text));
    if (out.length > 0) out.push({ text: GAP });
    if (cell.parts) {
      out.push(...cell.parts.map((p) => ({ text: p.text, color: p.color })));
      if (padded !== cell.text) out.push({ text: padded.slice(cell.text.length) });
    } else out.push({ text: padded, color: cell.color });
  }
  const cut: Segment[] = [];
  for (const segment of out) {
    const room = max - used;
    if (room <= 0) break;
    if (width(segment.text) <= room) {
      cut.push(segment);
      used += width(segment.text);
      continue;
    }
    cut.push({ ...segment, text: `${truncate(segment.text, room - 1)}…` });
    used = max;
    break;
  }
  return cut;
}

/** The first `columns` columns of `text`. */
export function truncate(text: string, columns: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = width(ch);
    if (used + w > columns) break;
    out += ch;
    used += w;
  }
  return out;
}

/** `text` cut or padded to exactly `columns` columns. */
export function fitText(text: string, columns: number): string {
  const w = width(text);
  if (w <= columns) return text + " ".repeat(columns - w);
  return `${truncate(text, Math.max(0, columns - 1))}…`;
}
