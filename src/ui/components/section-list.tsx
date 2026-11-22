import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, Index, on, Show } from "solid-js";
import type { Color } from "../../output/style.ts";
import { alignRow, columnWidths, fitText, type Segment } from "./cells.ts";
import { Line } from "./line.tsx";

// A list of rows split in titled sections (the Overview's Needs attention,
// Running, Next, Recent; later the Tasks and Runs tables). The selection is a
// row key owned by the view; this component draws it, keeps it in view and
// reports clicks: a click selects, a double click opens, the wheel scrolls.

export interface ListRow {
  key: string;
  cells: readonly Segment[];
}

export interface ListSection {
  id: string;
  title: string;
  rows: readonly ListRow[];
  /** Shown when there are no rows; null hides the section. */
  empty: string | null;
  /** The title's color when the selection is elsewhere (`magenta` for Needs attention). */
  color?: Color;
}

/** Two clicks on the same row within this time open it. */
export const DOUBLE_CLICK_MS = 400;

const rowId = (key: string) => `row:${key}`;

/** The row keys in display order. */
export function listKeys(sections: readonly ListSection[]): string[] {
  return sections.flatMap((s) => s.rows.map((r) => r.key));
}

export function SectionList(props: {
  sections: readonly ListSection[];
  selected: string | null;
  width: number;
  onSelect(key: string): void;
  onOpen(key: string): void;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  let lastClick = { key: "", at: 0 };

  createEffect(
    on(
      () => props.selected,
      (key) => {
        if (key && scroll) scroll.scrollChildIntoView(rowId(key));
      },
    ),
  );

  const click = (key: string, event: MouseEvent) => {
    if (event.button !== 0) return;
    const now = Date.now();
    const double = lastClick.key === key && now - lastClick.at < DOUBLE_CLICK_MS;
    lastClick = { key, at: double ? 0 : now };
    props.onSelect(key);
    if (double) props.onOpen(key);
  };

  return (
    <scrollbox ref={scroll} flexGrow={1} width={props.width} scrollY scrollX={false} viewportCulling>
      {/* Index, not For: the sections and rows are rebuilt every second (relative times); their renderables stay. */}
      <Index each={props.sections.filter((s) => s.rows.length > 0 || s.empty !== null)}>
        {(section) => {
          const widths = () => columnWidths(section().rows.map((r) => r.cells));
          const focused = () => section().rows.some((r) => r.key === props.selected);
          const title = () => {
            const label = `── ${section().title} (${section().rows.length}) `;
            return fitText(label + "─".repeat(Math.max(0, props.width - Bun.stringWidth(label))), props.width);
          };
          return (
            <box flexDirection="column" flexShrink={0}>
              <Line segments={[{ text: title(), color: focused() ? "cyan" : (section().color ?? "dim") }]} bold={focused()} />
              <Show when={section().rows.length > 0} fallback={<Line segments={[{ text: `  ${section().empty ?? ""}`, color: "dim" }]} />}>
                <Index each={section().rows}>
                  {(row) => {
                    const selected = () => row().key === props.selected;
                    const segments = () => {
                      const cells = alignRow(row().cells, widths(), Math.max(0, props.width - 2));
                      if (!selected()) return [{ text: "  " }, ...cells];
                      // The selected row is inverse across the whole width, in one color.
                      const text = cells.map((c) => c.text).join("");
                      return [{ text: fitText(`› ${text}`, props.width) }];
                    };
                    return (
                      <box id={rowId(row().key)} height={1} flexShrink={0} onMouseDown={(e: MouseEvent) => click(row().key, e)}>
                        <Line segments={segments()} inverse={selected()} />
                      </box>
                    );
                  }}
                </Index>
              </Show>
            </box>
          );
        }}
      </Index>
    </scrollbox>
  );
}
