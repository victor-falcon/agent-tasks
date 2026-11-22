import { type Accessor, For, Show } from "solid-js";
import { RUN_MARKS } from "../../output/symbols.ts";
import { agendaTime, formatSpan } from "../../output/time.ts";
import { tildify } from "../../paths.ts";
import { displayTimezone } from "../../task-info.ts";
import { useApp } from "../context.ts";
import { keyHint } from "../keymap/config.ts";
import type { Segment } from "./cells.ts";
import { Line } from "./line.tsx";
import type { RunPreviewData } from "./run-preview-model.ts";

// The preview of one run, shared by the list views (Overview, Runs): its
// result (the agent's summary, as Markdown) or, when it failed, the end of
// its captured log; a blocked run says it waits for you and how to attach.
// What it shows is read by run-preview-model.ts.

/** From this width on, a list view shares the screen with its preview. */
export const PREVIEW_MIN_WIDTH = 120;

/** The body of a run's preview (the pane around it is the view's). */
export function RunPreview(props: { preview: RunPreviewData }) {
  const app = useApp();
  const { store, theme } = app;
  const p = () => props.preview;
  const tz = () => {
    const ctx = store.ctx();
    return ctx ? displayTimezone(ctx) : "UTC";
  };
  const attachKey = () => keyHint(app.config.keymap, "attach");
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
      {/* Never squeezed out by the summary and the log, which share the rest. */}
      <box flexDirection="column" flexShrink={0}>
        <Line segments={head()} />
        <Line segments={[{ text: p().run.ref, color: "dim" }]} />
      </box>
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
}
