import { type Accessor, createMemo, For, Match, Show, Switch } from "solid-js";
import { RUN_MARKS } from "../../../output/symbols.ts";
import { agendaTime, formatSpan, relativeTime } from "../../../output/time.ts";
import { tildify } from "../../../paths.ts";
import { displayTimezone } from "../../../task-info.ts";
import type { Segment } from "../../components/cells.ts";
import { Line } from "../../components/line.tsx";
import { useApp } from "../../context.ts";
import { keyHint } from "../../keymap/config.ts";
import { buildPreview, type Preview as PreviewData } from "./model.ts";

type RunPreview = Extract<PreviewData, { kind: "run" }>;
type TaskPreview = Extract<PreviewData, { kind: "task" }>;

// The right pane of the Overview: what the selected row is about. A run shows
// its result (the agent's summary, as Markdown) or, when it failed, the end
// of its captured log; a blocked run says it waits for you and how to attach;
// a task in Next shows its schedule, its next slots and its last results.

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
  const attachKey = () => keyHint(app.config.keymap, "attach");

  return (
    <box flexDirection="column" width={props.width} flexShrink={0} border={["left"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
      <Switch>
        <Match when={preview().kind === "none"}>
          <Line segments={[{ text: "Nothing selected.", color: "dim" }]} />
        </Match>
        <Match when={preview().kind === "run" && (preview() as RunPreview)}>
          {(get: Accessor<RunPreview>) => {
            const p = () => get();
            const mark = () => RUN_MARKS[p().run.status];
            const took = () => {
              const r = p().run;
              if (!r.started_at) return "";
              const end = r.finished_at ? Date.parse(r.finished_at) : store.now().getTime();
              return ` · ${r.finished_at ? "took" : "for"} ${formatSpan(end - Date.parse(r.started_at))}`;
            };
            const head = (): Segment[] => [
              { text: `${mark().symbol} ${p().run.status === "succeeded" ? "ok" : p().run.status}`, color: mark().color },
              { text: ` · ${p().run.task_id}`, color: "bold" },
              { text: ` · ${agendaTime(new Date(p().run.at), tz(), store.now())}${took()}`, color: "dim" },
            ];
            return (
              <box flexDirection="column" flexGrow={1}>
                <Line segments={head()} />
                <Line segments={[{ text: p().run.ref, color: "dim" }]} />
                <Show when={p().blocked}>
                  <box border borderStyle="rounded" borderColor={theme.magenta} marginTop={1} paddingLeft={1} flexShrink={0}>
                    <Line segments={[{ text: "Waiting for you. ", color: "magenta" }, ...(attachKey() ? [{ text: attachKey()!, color: "yellow" as const }, { text: " attach to its session" }] : [])]} />
                  </box>
                </Show>
                <Show when={p().reason && !p().summary}>
                  <box marginTop={1} flexShrink={0}>
                    <Line segments={[{ text: p().reason!, color: "dim" }]} />
                  </box>
                </Show>
                <Show when={p().summary}>
                  <scrollbox flexGrow={1} marginTop={1}>
                    <markdown content={p().summary!} syntaxStyle={theme.syntax} fg={theme.fg} bg={theme.bg} conceal />
                  </scrollbox>
                </Show>
                <Show when={p().log}>
                  {(log: Accessor<{ path: string; lines: string[] }>) => (
                    <box flexDirection="column" flexGrow={1} marginTop={1}>
                      <Line segments={[{ text: `Last lines of ${tildify(log().path, store.ctx()?.env ?? {})}`, color: "dim" }]} />
                      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
                        <For each={log().lines}>{(line) => <Line segments={[{ text: line }]} />}</For>
                      </scrollbox>
                    </box>
                  )}
                </Show>
              </box>
            );
          }}
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
