import { useTerminalDimensions } from "@opentui/solid";
import { createMemo } from "solid-js";
import { localMachine } from "../../config.ts";
import { runnerDownReason } from "../../output/banner.ts";
import { RUN_MARKS } from "../../output/symbols.ts";
import { clockTime } from "../../output/time.ts";
import { displayTimezone } from "../../task-info.ts";
import type { Dashboard } from "../../tui/snapshot.ts";
import { useApp } from "../context.ts";
import { type Segment, truncate } from "./cells.ts";
import { Line } from "./line.tsx";

// The top line: the runner's health (green ticking, yellow late, red down
// with the reason), its last and next tick, today's counts, and the machine
// whose data this is (a client's `top` runs here over SSH, on the hub).
// On a narrow terminal it says less instead of running into itself: the
// machine goes first, then the tick details, then the title; the health dot
// and today's counts stay (headerSegments).

/** A tick this much past its time is late (the runner may be busy or asleep). */
const LATE_MS = 60_000;
/** The box's padding (one column on each side) and the least space between the two halves. */
const PADDING = 2;
const MIN_GAP = 2;
/** A down runner's reason is cut rather than dropped while this much of it fits. */
const MIN_REASON = 12;

const widthOf = (segments: readonly Segment[]) => segments.reduce((w, s) => w + Bun.stringWidth(s.text), 0);

/**
 * How much of the runner's line to show: everything, without the last tick,
 * without the next tick either, the word alone, the dot alone. A down
 * runner has no ticks to drop: its reason stays until "runner down".
 */
export type RunnerDetail = "full" | "no_last" | "no_ticks" | "word" | "dot";

export function runnerSegments(dash: Dashboard, now: Date, timezone: string, detail: RunnerDetail = "full"): Segment[] {
  const r = dash.runner;
  if (r.state !== "healthy") {
    const mark: Segment = { text: "✕", color: "red" };
    if (detail === "dot") return [mark];
    if (detail === "word") return [mark, { text: " runner down", color: "red" }];
    return [{ ...mark, text: "✕ runner not running" }, { text: ` · ${runnerDownReason(r, now)}` }];
  }
  const next = r.next_tick ? new Date(r.next_tick) : null;
  const late = next !== null && now.getTime() - next.getTime() > LATE_MS;
  const dot: Segment = { text: "●", color: late ? "yellow" : "green" };
  if (detail === "dot") return [dot];
  if (detail === "word") return [dot, { text: " runner" }];
  return [
    dot,
    { text: ` runner every ${r.every}` },
    ...(detail === "full" ? [{ text: ` · ticked ${clockTime(new Date(r.last_tick!), timezone)}` }] : []),
    ...(next && detail !== "no_ticks" ? [{ text: ` · next ${clockTime(next, timezone)}`, color: late ? ("yellow" as const) : undefined }] : []),
  ];
}

export function todaySegments(dash: Dashboard, label = true): Segment[] {
  const counts = [
    [RUN_MARKS.succeeded, dash.today.succeeded],
    [RUN_MARKS.failed, dash.today.failed],
    [RUN_MARKS.missed, dash.today.missed],
    [RUN_MARKS.blocked, dash.today.blocked],
  ] as const;
  const marks = counts.flatMap(([mark, n], i) => [...(i > 0 || label ? [{ text: " " }] : []), { text: `${mark.symbol}${n}`, color: n > 0 ? mark.color : ("dim" as const) }]);
  return label ? [{ text: "today" }, ...marks] : marks;
}

export interface HeaderInput {
  title: string;
  dash: Dashboard;
  now: Date;
  timezone: string;
  /** The machine whose data this is. */
  machine: string;
}

/** One way to say the header, from the most detailed to the shortest. */
interface Variant {
  title: boolean;
  runner: RunnerDetail;
  /** The word "today" before the counts. */
  label: boolean;
  hub: boolean;
}

const VARIANTS: readonly Variant[] = [
  { title: true, runner: "full", label: true, hub: true },
  { title: true, runner: "full", label: true, hub: false },
  { title: true, runner: "no_last", label: true, hub: false },
  { title: true, runner: "no_ticks", label: true, hub: false },
  { title: true, runner: "word", label: true, hub: false },
  { title: false, runner: "word", label: true, hub: false },
  { title: false, runner: "word", label: false, hub: false },
  { title: false, runner: "dot", label: false, hub: false },
];

/** A down runner's reason matters more than the title and the word "today": those go first, then the reason is cut. */
const DOWN_VARIANTS: readonly Variant[] = [
  { title: true, runner: "full", label: true, hub: true },
  { title: true, runner: "full", label: true, hub: false },
  { title: false, runner: "full", label: true, hub: false },
  { title: false, runner: "full", label: false, hub: false },
  { title: false, runner: "word", label: false, hub: false },
  { title: false, runner: "dot", label: false, hub: false },
];

/**
 * The header's two halves for a terminal `width` columns wide: the most
 * detailed variant that fits (see VARIANTS for the order things go in).
 * When even the shortest does not fit, the left half is cut.
 */
export function headerSegments(input: HeaderInput, width: number): { left: Segment[]; right: Segment[] } {
  const { title, dash, now, timezone, machine } = input;
  const room = width - PADDING - MIN_GAP;
  const build = (v: Variant) => ({
    left: [...(v.title ? [{ text: title, color: "bold" as const }, { text: " · " }] : []), ...runnerSegments(dash, now, timezone, v.runner)],
    right: [...todaySegments(dash, v.label), ...(v.hub ? [{ text: `   hub: ${machine}`, color: "dim" as const }] : [])],
  });
  const down = dash.runner.state !== "healthy";
  let last = build(VARIANTS.at(-1)!);
  for (const variant of down ? DOWN_VARIANTS : VARIANTS) {
    const halves = build(variant);
    const free = room - widthOf(halves.right);
    if (widthOf(halves.left) <= free) return halves;
    // A down runner's reason is cut while enough of it shows to be read.
    if (down && variant.runner === "full" && !variant.label && free - widthOf(halves.left.slice(0, 1)) - 3 >= MIN_REASON) return { left: cutSegments(halves.left, free), right: halves.right };
    last = halves;
  }
  // Narrower than anything planned for: keep the counts, cut what is left of the line.
  return { left: cutSegments(last.left, Math.max(0, room - widthOf(last.right))), right: last.right };
}

/** The first `columns` columns of `segments`, the last one ending in `…` when cut. */
function cutSegments(segments: readonly Segment[], columns: number): Segment[] {
  if (widthOf(segments) <= columns) return [...segments];
  const out: Segment[] = [];
  let left = columns - 1;
  for (const s of segments) {
    if (left <= 0) break;
    const text = truncate(s.text, left);
    out.push({ ...s, text });
    left -= Bun.stringWidth(text);
  }
  if (columns > 0) out.push({ text: "…" });
  return out;
}

export function Header() {
  const { store, title } = useApp();
  const dims = useTerminalDimensions();
  const halves = createMemo((): { left: Segment[]; right: Segment[] } => {
    const dash = store.dash();
    const ctx = store.ctx();
    if (!dash || !ctx) return { left: [{ text: title, color: "bold" }, { text: " · loading…", color: "dim" }], right: [] };
    return headerSegments({ title, dash, now: store.now(), timezone: displayTimezone(ctx), machine: localMachine(ctx.config.config) }, dims().width);
  });
  return (
    <box flexDirection="row" height={1} flexShrink={0} justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <Line segments={halves().left} />
      <Line segments={halves().right} />
    </box>
  );
}
