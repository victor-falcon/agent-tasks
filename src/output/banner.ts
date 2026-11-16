import type { Context } from "../context.ts";
import { contextRunnerHealth, type RunnerHealth } from "../runner-health.ts";
import { stderrStyle } from "./style.ts";
import { relativeTime } from "./time.ts";

/** Why the runner is not healthy, in a few words: `last tick 3h ago` / `no tick recorded yet`. */
export function runnerDownReason(health: RunnerHealth, now: Date): string {
  return health.last_tick === null ? "no tick recorded yet" : `last tick ${relativeTime(new Date(health.last_tick), now)}, expected every ${health.every}`;
}

/**
 * One warning line on stderr when the runner has no recent heartbeat. Human
 * output only: with `--json` the health is part of the data, if at all.
 * Returns the health so callers don't read the heartbeat twice.
 */
export function runnerBanner(ctx: Context): RunnerHealth {
  const health = contextRunnerHealth(ctx);
  if (!ctx.json && health.state !== "healthy") {
    const style = stderrStyle(ctx);
    ctx.stderr.write(`${style.paint("yellow", `! runner is not running (${runnerDownReason(health, ctx.now)}); scheduled tasks won't start. Start it with: agent-tasks runner`)}\n`);
  }
  return health;
}
