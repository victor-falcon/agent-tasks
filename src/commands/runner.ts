import { parseCommandArgs } from "../args.ts";
import { BUILTIN_DEFAULTS } from "../config.ts";
import { createContext } from "../context.ts";
import { isDuration } from "../duration.ts";
import { UsageError } from "../errors.ts";
import { interruptibleSleep, runRunner } from "../runner.ts";
import { releaseRunnerLock } from "../runner-lock.ts";
import type { Command } from "./types.ts";

/** Ctrl-C, kill, and the terminal tab closing. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const runner: Command = {
  name: "runner",
  summary: "Keep ticking every few minutes and show what runs (leave it open in a tab)",
  usage: `Usage: agent-tasks runner [--every 5m] [--once] [--quiet]

A plain long-lived process: runs a tick every interval, shows each event as
it happens (launched, succeeded, failed, missed, blocked…) and sends them to
the notifiers in the config (by default, a desktop notification for
failed, timed_out and blocked). Leave it open in a terminal tab. A tick that
fails is shown as ⚠ and the runner carries on. Ctrl-C stops it after the
current tick; a second Ctrl-C stops it right away.

Only one runner runs at a time (state/runner.lock). The screen output is
also appended to state/runner.log. On a terminal, it keeps a status line at
the bottom and reports itself to Herdr (title and agent state), so task tabs
nest under it. With --json, it prints one JSON object per line.

Options:
  --every <duration>  Interval between ticks (default: runner.every in the config, or 5m;
                      read at start, so a change needs a restart)
  --once              Run a single tick and exit
  --quiet             Events only: no tick lines and no status line`,
  async run(ctx, args) {
    const { values } = parseCommandArgs(args, { every: { type: "string" }, once: { type: "boolean" }, quiet: { type: "boolean" } }, { maxPositionals: 0 });
    const every = values.every ?? ctx.config.config.runner?.every ?? BUILTIN_DEFAULTS.runner_every;
    if (!isDuration(every)) throw new UsageError(`--every: invalid duration "${every}" (expected e.g. 30s, 5m or 1h)`);

    // The clock is the real time, shifted so that the first tick happens at `--now`.
    const offset = ctx.now.getTime() - Date.now();
    // The first signal stops after the current tick; a second one (a tick stuck in a launcher) exits now.
    const controller = new AbortController();
    const stop = () => {
      if (!controller.signal.aborted) return controller.abort();
      releaseRunnerLock(ctx.paths, process.pid);
      ctx.stderr.write("agent-tasks: stopped in the middle of a tick\n");
      process.exit(130);
    };
    for (const signal of SIGNALS) process.on(signal, stop);
    try {
      return await runRunner(
        ctx,
        { every, once: values.once ?? false, quiet: values.quiet ?? false },
        {
          now: () => new Date(Date.now() + offset),
          sleep: interruptibleSleep,
          context: (now) => createContext({ now, json: ctx.json, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands }),
          signal: controller.signal,
          stdout: ctx.stdout,
          pid: process.pid,
        },
      );
    } finally {
      for (const signal of SIGNALS) process.off(signal, stop);
    }
  },
};

export default runner;
