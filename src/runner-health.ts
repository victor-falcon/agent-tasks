import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { Context } from "./context.ts";
import { BUILTIN_DEFAULTS } from "./config.ts";
import { parseDuration } from "./duration.ts";
import type { DataPaths } from "./paths.ts";
import type { Tick } from "./schema.ts";
import { displayTimezone } from "./task-info.ts";
import { formatInZone } from "./time.ts";

// Whether the runner is alive, from the heartbeat (`state/ticks.jsonl`) alone.

const TAIL_BYTES = 64 * 1024;

/** The last valid line of `ticks.jsonl`, reading only the end of the file. */
export function lastTick(paths: Pick<DataPaths, "ticksFile">): Tick | null {
  if (!existsSync(paths.ticksFile)) return null;
  const fd = openSync(paths.ticksFile, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (length < size) lines.shift(); // the first line may be cut
    for (const line of lines.reverse()) {
      if (line.trim() === "") continue;
      try {
        const tick = JSON.parse(line) as Tick;
        if (typeof tick?.at === "string" && !Number.isNaN(Date.parse(tick.at))) return tick;
      } catch {
        // A line being written or a broken one: look further back.
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

export type RunnerState = "healthy" | "stale" | "never";

export interface RunnerHealth {
  /** `healthy`: a tick newer than 2 × `runner.every`; `stale`: older; `never`: no tick at all. */
  state: RunnerState;
  every: string;
  last_tick: string | null;
  /** When the next tick is expected (last tick + every), if there was one. */
  next_tick: string | null;
}

export function runnerEvery(ctx: Pick<Context, "config">): string {
  return ctx.config.config.runner?.every ?? BUILTIN_DEFAULTS.runner_every;
}

/** `next_tick` is written in `timezone`, like other timestamps the CLI prints. */
export function runnerHealth(paths: Pick<DataPaths, "ticksFile">, every: string, now: Date, timezone: string): RunnerHealth {
  const tick = lastTick(paths);
  if (!tick) return { state: "never", every, last_tick: null, next_tick: null };
  const everyMs = parseDuration(every);
  const at = Date.parse(tick.at);
  return {
    state: now.getTime() - at < 2 * everyMs ? "healthy" : "stale",
    every,
    last_tick: tick.at,
    next_tick: formatInZone(new Date(at + everyMs), timezone),
  };
}

export function contextRunnerHealth(ctx: Context): RunnerHealth {
  return runnerHealth(ctx.paths, runnerEvery(ctx), ctx.now, displayTimezone(ctx));
}
