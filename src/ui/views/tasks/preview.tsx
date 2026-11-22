import { For, Show } from "solid-js";
import { scheduleText } from "../../../output/schedule-text.ts";
import { describeSchedule } from "../../../task-info.ts";
import { alignRow, columnWidths } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useApp } from "../../context.ts";
import { LAST_RESULTS, runCells, type TaskItem, titleSegments } from "./model.ts";
import { NextRuns, SettingsSummary, useDisplayTimezone } from "./parts.tsx";

// The right pane of the Tasks tab: the selected task's description, its
// schedule and next slots, the settings a run gets, and its last runs.

export function TaskPreview(props: { item: TaskItem | null; width: number }) {
  const { store, theme } = useApp();
  const tz = useDisplayTimezone();
  const lastRuns = () => {
    const it = props.item;
    if (!it) return [];
    const rows = it.runs.filter((r) => r.run.status !== "superseded" && r.run.status !== "cancelled").slice(-LAST_RESULTS).reverse().map((r) => runCells(r, store.now(), tz()));
    const widths = columnWidths(rows);
    return rows.map((cells) => alignRow(cells, widths, Math.max(0, props.width - 4)));
  };

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
      <Show when={props.item} fallback={<Line segments={[{ text: "Nothing selected.", color: "dim" }]} />}>
        {(get: () => TaskItem) => {
          const it = () => get();
          return (
            // A scrollbox: a long description or a short terminal must not hide the last results.
            <scrollbox flexGrow={1} scrollY scrollX={false}>
              <Line segments={titleSegments(it())} />
              <Show when={it().task.description}>
                <Line segments={[{ text: it().task.description!, color: "dim" }]} wrap />
              </Show>
              <Line segments={[{ text: "" }]} />
              <Line segments={[{ text: "Schedule  ", color: "dim" }, { text: scheduleText(it().task.schedule, tz(), store.now()) }, { text: `  ${describeSchedule(it().task)}`, color: "dim" }]} />
              <Line segments={[{ text: "Machine   ", color: "dim" }, { text: it().task.machine }]} />
              <Line segments={[{ text: "Folder    ", color: "dim" }, { text: it().task.cwd }]} />
              <Line segments={[{ text: "" }]} />
              <NextRuns item={it()} />
              <Line segments={[{ text: "" }]} />
              <SettingsSummary item={it()} width={10} />
              <Line segments={[{ text: "" }]} />
              <Line segments={[{ text: `Last ${LAST_RESULTS} results`, color: "dim" }]} />
              <Show when={lastRuns().length > 0} fallback={<Line segments={[{ text: "  no runs yet", color: "dim" }]} />}>
                <For each={lastRuns()}>{(cells) => <Line segments={[{ text: "  " }, ...cells]} />}</For>
              </Show>
            </scrollbox>
          );
        }}
      </Show>
    </box>
  );
}
