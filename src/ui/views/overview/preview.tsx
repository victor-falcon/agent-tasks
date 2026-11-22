import { type Accessor, createMemo, For, Match, Show, Switch } from "solid-js";
import { RUN_MARKS } from "../../../output/symbols.ts";
import { agendaTime, relativeTime } from "../../../output/time.ts";
import { displayTimezone } from "../../../task-info.ts";
import type { Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { RunPreview } from "../../components/run-preview.tsx";
import { useApp } from "../../context.ts";
import { buildPreview, type Preview as PreviewData } from "./model.ts";

type RunPreviewData = Extract<PreviewData, { kind: "run" }>;
type TaskPreview = Extract<PreviewData, { kind: "task" }>;

// The right pane of the Overview: what the selected row is about. A run shows
// the shared run preview (components/run-preview.tsx); a task in Next shows
// its schedule, its next slots and its last results.

export function Preview(props: { rowKey: string | null; width: number }) {
  const app = useApp();
  const { store, theme } = app;
  // Read again on every reload (store.version), not on every clock tick.
  const preview = createMemo((): PreviewData => {
    store.version();
    const ctx = store.ctx();
    const dash = store.dash();
    return ctx && dash ? buildPreview(ctx, dash, props.rowKey) : { kind: "none" };
  });
  const tz = () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
      <Switch>
        <Match when={preview().kind === "none"}>
          <Line segments={[{ text: "Nothing selected.", color: "dim" }]} />
        </Match>
        <Match when={preview().kind === "run" && (preview() as RunPreviewData)}>
          {(get: Accessor<RunPreviewData>) => <RunPreview preview={get()} />}
        </Match>
        <Match when={preview().kind === "task" && (preview() as TaskPreview)}>
          {(get: Accessor<TaskPreview>) => {
            const p = () => get();
            const strip = (): Segment[] => (p().strip.length === 0 ? [{ text: "no runs yet", color: "dim" }] : p().strip.map((s) => ({ text: RUN_MARKS[s].symbol, color: RUN_MARKS[s].color })));
            return (
              <box flexDirection="column" flexGrow={1}>
                <Line segments={[{ text: p().title, color: "bold" }, { text: ` · ${p().next.task_id}`, color: "dim" }]} />
                <Show when={p().description}>
                  <Line segments={[{ text: p().description!, color: "dim" }]} />
                </Show>
                <Line segments={[{ text: "" }]} />
                <Line segments={[{ text: "Schedule  ", color: "dim" }, { text: p().next.schedule }, ...(p().next.state === "paused" ? [{ text: " (paused)", color: "yellow" as const }] : [])]} />
                <Line segments={[{ text: "Machine   ", color: "dim" }, { text: p().next.machine }]} />
                <Line segments={[{ text: "" }]} />
                <Line segments={[{ text: "Next runs", color: "dim" }]} />
                <Show when={p().slots.length > 0} fallback={<Line segments={[{ text: "  none (paused or finished)", color: "dim" }]} />}>
                  <For each={p().slots}>
                    {(slot) => <Line segments={[{ text: `  ${agendaTime(new Date(slot), tz(), store.now())}` }, { text: `  ${relativeTime(new Date(slot), store.now())}`, color: "dim" }]} />}
                  </For>
                </Show>
                <Line segments={[{ text: "" }]} />
                <Line segments={[{ text: "Last results  ", color: "dim" }, ...strip()]} />
              </box>
            );
          }}
        </Match>
      </Switch>
    </box>
  );
}
