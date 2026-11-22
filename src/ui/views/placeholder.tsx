import { Line } from "../components/line.tsx";
import { useViewKeys } from "../keymap/layer.ts";
import type { ViewKeys } from "../keymap/spec.ts";

// Views that are not built yet: they say what to run instead, and take the
// global keys so the tabs and help work there too.

function Placeholder(props: { keys: ViewKeys; what: string; cli: string }) {
  useViewKeys(props.keys, {});
  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Line segments={[{ text: `${props.what} is not in the new dashboard yet.`, color: "bold" }]} />
      <Line segments={[{ text: "Meanwhile: " }, { text: props.cli, color: "cyan" }]} />
    </box>
  );
}

export function PlaceholderTab(props: { keys: ViewKeys; what: string; cli: string }) {
  return <Placeholder keys={props.keys} what={`The ${props.what} tab`} cli={props.cli} />;
}

export function PlaceholderDetail(props: { keys: ViewKeys; what: string; cli: string }) {
  return <Placeholder keys={props.keys} what={props.what} cli={props.cli} />;
}
