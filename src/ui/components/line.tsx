import { For } from "solid-js";
import { useApp } from "../context.ts";
import { paint } from "../theme.ts";
import type { Segment } from "./cells.ts";

/** Styles of a span: its palette color (never OpenTUI's default white) and attributes. */
function spanStyle(color: Segment["color"], fg: ReturnType<typeof paint>["fg"], bg: ReturnType<typeof paint>["fg"], inverse: boolean, bold: boolean) {
  return { fg, bg, dim: color === "dim", bold: bold || color === "bold", inverse: inverse || color === "inverse" };
}

/** One line of colored segments (`inverse` for the selected row), not wrapped unless `wrap`. */
export function Line(props: { segments: readonly Segment[]; inverse?: boolean; bold?: boolean; wrap?: boolean }) {
  const { theme } = useApp();
  return (
    <text fg={theme.fg} bg={theme.bg} wrapMode={props.wrap ? "word" : "none"} selectable={false}>
      <For each={props.segments}>
        {(segment) => <span style={spanStyle(segment.color, paint(theme, segment.color).fg, theme.bg, props.inverse ?? false, props.bold ?? false)}>{segment.text}</span>}
      </For>
    </text>
  );
}
