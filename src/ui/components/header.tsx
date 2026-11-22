import { localMachine } from "../../config.ts";
import { runnerDownReason } from "../../output/banner.ts";
import { RUN_MARKS } from "../../output/symbols.ts";
import { clockTime } from "../../output/time.ts";
import { displayTimezone } from "../../task-info.ts";
import type { Dashboard } from "../../tui/snapshot.ts";
import { useApp } from "../context.ts";
import type { Segment } from "./cells.ts";
import { Line } from "./line.tsx";

// The top line: the runner's health (green ticking, yellow late, red down
// with the reason), its last and next tick, today's counts, and the machine
// whose data this is (a client's `top` runs here over SSH, on the hub).

/** A tick this much past its time is late (the runner may be busy or asleep). */
const LATE_MS = 60_000;

export function runnerSegments(dash: Dashboard, now: Date, timezone: string): Segment[] {
  const r = dash.runner;
  if (r.state !== "healthy") return [{ text: "✕ runner not running", color: "red" }, { text: ` · ${runnerDownReason(r, now)}` }];
  const next = r.next_tick ? new Date(r.next_tick) : null;
  const late = next !== null && now.getTime() - next.getTime() > LATE_MS;
  return [
    { text: "●", color: late ? "yellow" : "green" },
    { text: ` runner every ${r.every} · ticked ${clockTime(new Date(r.last_tick!), timezone)}` },
    ...(next ? [{ text: ` · next ${clockTime(next, timezone)}`, color: late ? ("yellow" as const) : undefined }] : []),
  ];
}

export function todaySegments(dash: Dashboard): Segment[] {
  const counts = [
    [RUN_MARKS.succeeded, dash.today.succeeded],
    [RUN_MARKS.failed, dash.today.failed],
    [RUN_MARKS.missed, dash.today.missed],
    [RUN_MARKS.blocked, dash.today.blocked],
  ] as const;
  return [{ text: "today" }, ...counts.flatMap(([mark, n]) => [{ text: " " }, { text: `${mark.symbol}${n}`, color: n > 0 ? mark.color : ("dim" as const) }])];
}

export function Header() {
  const { store, title } = useApp();
  const left = (): Segment[] => {
    const dash = store.dash();
    const ctx = store.ctx();
    if (!dash || !ctx) return [{ text: title, color: "bold" }, { text: " · loading…", color: "dim" }];
    return [{ text: title, color: "bold" }, { text: " · " }, ...runnerSegments(dash, store.now(), displayTimezone(ctx))];
  };
  const right = (): Segment[] => {
    const dash = store.dash();
    const ctx = store.ctx();
    if (!dash || !ctx) return [];
    return [...todaySegments(dash), { text: `   hub: ${localMachine(ctx.config.config)}`, color: "dim" }];
  };
  return (
    <box flexDirection="row" height={1} flexShrink={0} justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <Line segments={left()} />
      <Line segments={right()} />
    </box>
  );
}
