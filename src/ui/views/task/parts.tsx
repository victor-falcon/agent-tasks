import { createMemo, For, Show } from "solid-js";
import { scheduleText } from "../../../output/schedule-text.ts";
import { describeSchedule } from "../../../task-info.ts";
import { fitText, type Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import type { TaskItem } from "../tasks/model.ts";
import { NextRuns, SettingsSummary, useDisplayTimezone } from "../tasks/parts.tsx";
import { instructionsNote, instructionsOf, settingRows, settingsColumns } from "./model.ts";

// The parts of the Task detail that scroll (its Runs are a list): Overview,
// Instructions and Settings.

const LABEL_WIDTH = 12;

function Row(props: { label: string; value: Segment[] }) {
  return <Line segments={[{ text: fitText(props.label, LABEL_WIDTH), color: "dim" }, ...props.value]} wrap />;
}

/** Title, id, description, folder, machine, schedule (in words, as cron, its time zone), next slots, state. */
export function OverviewPart(props: { item: TaskItem }) {
  const { store, config } = useApp();
  const folderKey = keyHint(config.keymap, "open_folder");
  const tz = useDisplayTimezone();
  const task = () => props.item.task;
  return (
    <box flexDirection="column">
      <Show when={task().description}>
        <Line segments={[{ text: task().description! }]} wrap />
        <Line segments={[{ text: "" }]} />
      </Show>
      <Row label="Id" value={[{ text: task().id }]} />
      <Row label="State" value={[{ text: props.item.state, color: props.item.state === "active" ? "green" : "dim" }]} />
      <Row label="Folder" value={[{ text: task().cwd }, ...(folderKey ? [{ text: `  ${folderKey} open a shell there`, color: "dim" as const }] : [])]} />
      <Row label="Machine" value={[{ text: task().machine }]} />
      <Row label="Schedule" value={[{ text: scheduleText(task().schedule, tz(), store.now()) }]} />
      <Row label="" value={[{ text: describeSchedule(task()), color: "dim" }]} />
      <Row label="Time zone" value={[{ text: props.item.resolution.timezone }]} />
      <Line segments={[{ text: "" }]} />
      <NextRuns item={props.item} />
      <Line segments={[{ text: "" }]} />
      <SettingsSummary item={props.item} width={LABEL_WIDTH} />
    </box>
  );
}

/** The instructions as Markdown, as written or (`asAgent`) as the agent receives them. */
export function InstructionsPart(props: { item: TaskItem; asAgent: boolean }) {
  const { store, config, theme } = useApp();
  const text = createMemo(() => {
    const ctx = store.ctx();
    return ctx ? instructionsOf(ctx, props.item, props.asAgent) : null;
  });
  const toggle = keyHint(config.keymap, "toggle_instructions");
  const note = (): Segment[] => {
    const t = text();
    if (!t) return [];
    return [{ text: instructionsNote(t, props.asAgent), color: "dim" }, ...(toggle ? [{ text: `  ${toggle} ${props.asAgent ? "as written" : "as the agent receives them"}`, color: "dim" as const }] : [])];
  };
  return (
    <box flexDirection="column">
      <Line segments={note()} wrap />
      <For each={text()?.missing ?? []}>{(path) => <Line segments={[{ text: `missing personal file: ${path}`, color: "yellow" }]} />}</For>
      <Line segments={[{ text: "" }]} />
      <markdown content={text()?.text ?? ""} syntaxStyle={theme.syntax} fg={theme.fg} bg={theme.bg} conceal />
    </box>
  );
}

/** Every resolved setting, its value and where it comes from. */
export function SettingsPart(props: { item: TaskItem }) {
  const { store } = useApp();
  const rows = createMemo(() => {
    const ctx = store.ctx();
    return ctx ? settingRows(ctx, props.item) : [];
  });
  const columns = () => settingsColumns(rows());
  return (
    <box flexDirection="column">
      <Line segments={[{ text: "Every setting a run gets and where it comes from (task > profile > config > default). Read-only.", color: "dim" }]} wrap />
      <Line segments={[{ text: "" }]} />
      <For each={rows()}>
        {(r) => <Line segments={[{ text: r.key.padEnd(columns().key), color: "dim" }, { text: "  " }, { text: fitText(r.value, columns().value) }, { text: "  " }, { text: `← ${r.source}`, color: r.source === "task" ? "cyan" : "dim" }]} />}
      </For>
    </box>
  );
}
