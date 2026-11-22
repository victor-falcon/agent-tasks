import { For } from "solid-js";
import { useApp } from "../context.ts";
import { Line } from "../components/line.tsx";

/** Messages at the bottom right, newest last: a click dismisses one; errors stay until dismissed. */
export function Toasts() {
  const app = useApp();
  return (
    <box position="absolute" right={1} bottom={1} flexDirection="column" alignItems="flex-end" zIndex={50}>
      <For each={app.ui.toasts()}>
        {(toast) => (
          <box
            border
            borderStyle="rounded"
            borderColor={toast.error ? app.theme.red : app.theme.border}
            backgroundColor={app.theme.bg}
            paddingLeft={1}
            paddingRight={1}
            maxWidth={Math.max(30, Math.floor(app.renderer.width * 0.6))}
            onMouseDown={() => app.ui.dismiss(toast.id)}
          >
            <Line segments={[{ text: toast.text, color: toast.error ? "red" : undefined }]} wrap />
          </box>
        )}
      </For>
    </box>
  );
}
