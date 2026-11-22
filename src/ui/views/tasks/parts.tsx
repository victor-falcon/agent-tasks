import { For } from "solid-js";
import { Line } from "../../components/line.tsx";
import { displayTimezone } from "../../../task-info.ts";
import { useApp } from "../../context.ts";
import { nextRunLines, settingsSummary, type TaskItem } from "./model.ts";

// Pieces the Tasks preview and the Task detail's Overview both show. Times
// are in the display time zone, like the table and the Overview tab (the
// task's own zone is in its schedule line).

/** The display time zone (config, else the system's). */
export function useDisplayTimezone(): () => string {
  const { store } = useApp();
  return () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };
}

/** "Next runs" and the next slots (relative times move with the clock). */
export function NextRuns(props: { item: TaskItem }) {
  const { store } = useApp();
  const tz = useDisplayTimezone();
  return (
    <>
      <Line segments={[{ text: "Next runs", color: "dim" }]} />
      <For each={nextRunLines(props.item, store.now(), tz())}>{(segments) => <Line segments={segments} />}</For>
    </>
  );
}

/** Agent, timeout, retries, keep open, with labels `width` columns wide. */
export function SettingsSummary(props: { item: TaskItem; width: number }) {
  return <For each={settingsSummary(props.item.resolution)}>{(s) => <Line segments={[{ text: s.label.padEnd(props.width), color: "dim" }, { text: s.value }]} />}</For>;
}
