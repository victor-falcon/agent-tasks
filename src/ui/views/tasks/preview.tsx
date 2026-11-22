import { For, Show } from "solid-js";
import { scheduleText } from "../../../output/schedule-text.ts";
import { agendaTime, relativeTime } from "../../../output/time.ts";
import { describeSchedule } from "../../../task-info.ts";
import { alignRow, columnWidths } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useApp } from "../../context.ts";
import { LAST_RESULTS, runCells, settingsSummary, type TaskItem } from "./model.ts";

// The right pane of the Tasks tab: the selected task's description, its
// schedule and next slots, the settings a run gets, and its last runs.

export function TaskPreview(props: { item: TaskItem | null; width: number }) {
  const { store, theme } = useApp();
  const tz = () => props.item?.resolution.timezone ?? "UTC";
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
            <box flexDirection="column" flexGrow={1}>
              <Line segments={[{ text: it().task.title, color: "bold" }, { text: ` · ${it().task.id} · ${it().state}`, color: "dim" }]} />
              <Show when={it().task.description}>
                <Line segments={[{ text: it().task.description!, color: "dim" }]} wrap />
              </Show>
              <Line segments={[{ text: "" }]} />
              <Line segments={[{ text: "Schedule  ", color: "dim" }, { text: scheduleText(it().task.schedule, tz(), store.now()) }, { text: `  ${describeSchedule(it().task)}`, color: "dim" }]} />
              <Line segments={[{ text: "Machine   ", color: "dim" }, { text: it().task.machine }]} />
              <Line segments={[{ text: "Folder    ", color: "dim" }, { text: it().task.cwd }]} />
              <Line segments={[{ text: "" }]} />
              <Line segments={[{ text: "Next runs", color: "dim" }]} />
              <Show when={it().next.length > 0} fallback={<Line segments={[{ text: `  none (${it().state})`, color: "dim" }]} />}>
                <For each={it().next}>{(slot) => <Line segments={[{ text: `  ${agendaTime(new Date(slot), tz(), store.now())}` }, { text: `  ${relativeTime(new Date(slot), store.now())}`, color: "dim" }]} />}</For>
              </Show>
              <Line segments={[{ text: "" }]} />
              <For each={settingsSummary(it().resolution)}>{(s) => <Line segments={[{ text: s.label.padEnd(10), color: "dim" }, { text: s.value }]} />}</For>
              <Line segments={[{ text: "" }]} />
              <Line segments={[{ text: `Last ${LAST_RESULTS} results`, color: "dim" }]} />
              <Show when={lastRuns().length > 0} fallback={<Line segments={[{ text: "  no runs yet", color: "dim" }]} />}>
                <For each={lastRuns()}>{(cells) => <Line segments={[{ text: "  " }, ...cells]} />}</For>
              </Show>
            </box>
          );
        }}
      </Show>
    </box>
  );
}
