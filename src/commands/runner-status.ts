import { parseCommandArgs } from "../args.ts";
import { output } from "../context.ts";
import { formatDuration, parseDuration } from "../duration.ts";
import { pidAlive, readRunnerLock, runnerLockPath } from "../runner-lock.ts";
import { readTicks } from "../store.ts";
import type { Command } from "./types.ts";

/** A heartbeat older than this many intervals means the runner is stuck. */
const STALLED_INTERVALS = 3;

function ago(ms: number): string {
  return ms < 1000 ? "just now" : `${formatDuration(ms)} ago`;
}

const runnerStatus: Command = {
  name: "runner status",
  summary: "Say whether a runner is alive, where, and when it ticks next",
  usage: `Usage: agent-tasks runner status

Reads state/runner.lock and the heartbeat (state/ticks.jsonl): whether a
runner is alive (its pid exists), its terminal, since when it runs, and its
last and next tick. Exits with 1 when no runner is running.`,
  run(ctx, args) {
    parseCommandArgs(args, {}, { maxPositionals: 0 });
    const lock = readRunnerLock(ctx.paths);
    const alive = lock ? pidAlive(lock.pid) : false;
    const lastTick = readTicks(ctx.paths).items.at(-1) ?? null;
    const nowMs = ctx.now.getTime();
    const sinceLast = lastTick ? nowMs - Date.parse(lastTick.at) : null;
    let everyMs: number | null = null;
    try {
      everyMs = lock ? parseDuration(lock.every) : null;
    } catch {
      everyMs = null;
    }
    const stalled = alive && sinceLast !== null && everyMs !== null && sinceLast > STALLED_INTERVALS * everyMs;

    const data = {
      running: alive,
      stalled,
      stale_lock: lock !== null && !alive,
      lock_file: runnerLockPath(ctx.paths),
      pid: lock?.pid ?? null,
      terminal: lock?.terminal ?? null,
      started_at: lock?.started_at ?? null,
      every: lock?.every ?? null,
      last_tick_at: lastTick?.at ?? null,
      last_tick_mode: lastTick?.mode ?? null,
      next_tick_at: alive ? (lock?.next_tick_at ?? null) : null,
    };

    output(ctx, data, () => {
      const last = lastTick ? `last tick ${lastTick.at} (${ago(sinceLast!)}${lastTick.mode ? `, ${lastTick.mode}` : ""})` : "no tick yet";
      if (!alive) {
        const staleNote = lock ? ` (stale lock from pid ${lock.pid}, which no longer exists)` : "";
        return `✕ No runner is running${staleNote}. ${last}.\nStart one in a terminal tab with: agent-tasks runner`;
      }
      const lines = [
        `● Runner running: pid ${lock!.pid}${lock!.terminal ? ` in terminal ${lock!.terminal}` : ""}, since ${lock!.started_at}, every ${lock!.every}`,
        `  ${last}${data.next_tick_at ? ` · next tick ${data.next_tick_at}` : ""}`,
      ];
      if (stalled) lines.push(`⚠ No heartbeat for ${formatDuration(sinceLast!)}: the runner may be stuck in a tick.`);
      return lines.join("\n");
    });
    return alive ? 0 : 1;
  },
};

export default runnerStatus;
