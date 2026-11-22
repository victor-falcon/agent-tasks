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
// and today's counts stay.

/** A tick this much past its time is late (the runner may be busy or asleep). */
const LATE_MS = 60_000;
/** Columns taken around the two halves: the box's padding and the least space between them. */
const CHROME = 2 + 2;

const widthOf = (segments: readonly Segment[]) => segments.reduce((w, s) => w + Bun.stringWidth(s.text), 0);

/** How much of the runner's line to show, from all of it (0) to the dot alone. */
type RunnerDetail = 0 | 1 | 2 | 3 | 4;

export function runnerSegments(dash: Dashboard, now: Date, timezone: string, detail: RunnerDetail = 0): Segment[] {
  const r = dash.runner;
  if (r.state !== "healthy") {
    const mark = { text: "✕", color: "red" as const };
    if (detail >= 4) return [mark];
    if (detail >= 2) return [mark, { text: " runner down", color: "red" }];
    return [{ ...mark, text: "✕ runner not running" }, { text: ` · ${runnerDownReason(r, now)}` }];
  }
  const next = r.next_tick ? new Date(r.next_tick) : null;
  const late = next !== null && now.getTime() - next.getTime() > LATE_MS;
  const dot: Segment = { text: "●", color: late ? "yellow" : "green" };
  if (detail >= 4) return [dot];
  if (detail >= 3) return [dot, { text: " runner" }];
  const nextSegment: Segment[] = next && detail <= 1 ? [{ text: ` · next ${clockTime(next, timezone)}`, color: late ? "yellow" : undefined }] : [];
  return [dot, { text: ` runner every ${r.every}` }, ...(detail === 0 ? [{ text: ` · ticked ${clockTime(new Date(r.last_tick!), timezone)}` }] : []), ...nextSegment];
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

/**
 * The header's two halves for a terminal `width` columns wide: the most
 * detailed version that fits, dropping the least useful part first (the
 * machine, the last tick, the next tick, the interval, the title, the word
 * "today"). When even the shortest does not fit, the left half is cut.
 */
export function headerSegments(input: HeaderInput, width: number): { left: Segment[]; right: Segment[] } {
  const { title, dash, now, timezone, machine } = input;
  const titled = (runner: Segment[]): Segment[] => [{ text: title, color: "bold" }, { text: " · " }, ...runner];
  const hub: Segment = { text: `   hub: ${machine}`, color: "dim" };
  const variants: { left: Segment[]; right: Segment[] }[] = [
    { left: titled(runnerSegments(dash, now, timezone, 0)), right: [...todaySegments(dash), hub] },
    { left: titled(runnerSegments(dash, now, timezone, 0)), right: todaySegments(dash) },
    { left: titled(runnerSegments(dash, now, timezone, 1)), right: todaySegments(dash) },
    { left: titled(runnerSegments(dash, now, timezone, 2)), right: todaySegments(dash) },
    { left: titled(runnerSegments(dash, now, timezone, 3)), right: todaySegments(dash) },
    { left: runnerSegments(dash, now, timezone, 3), right: todaySegments(dash) },
    { left: runnerSegments(dash, now, timezone, 3), right: todaySegments(dash, false) },
    { left: runnerSegments(dash, now, timezone, 4), right: todaySegments(dash, false) },
  ];
  const fits = variants.find((v) => widthOf(v.left) + widthOf(v.right) + CHROME <= width);
  if (fits) return fits;
  // Narrower than anything planned for: keep the counts, cut what is left of the line.
  const last = variants.at(-1)!;
  return { left: cutSegments(last.left, Math.max(0, width - CHROME - widthOf(last.right))), right: last.right };
}

function cutSegments(segments: readonly Segment[], columns: number): Segment[] {
  const out: Segment[] = [];
  let room = columns;
  for (const s of segments) {
    if (room <= 0) break;
    const text = truncate(s.text, room);
    out.push({ ...s, text });
    room -= Bun.stringWidth(text);
  }
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
