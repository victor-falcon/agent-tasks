import { parseCommandArgs } from "../args.ts";
import { BUILTIN_DEFAULTS } from "../config.ts";
import { createContext } from "../context.ts";
import { isDuration } from "../duration.ts";
import { UsageError } from "../errors.ts";
import { interruptibleSleep, runRunner } from "../runner.ts";
import { releaseRunnerLock } from "../runner-lock.ts";
import { selfCommand } from "../ui/exec.ts";
import { loadTuiConfig } from "../ui/keymap/config.ts";
import { type AppHandle, canShowDashboard, dashboardFailed, startDashboard } from "../ui/load.ts";
import type { Command } from "./types.ts";

/** Ctrl-C, kill, and the terminal tab closing. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const runner: Command = {
  name: "runner",
  summary: "Keep ticking every few minutes and show what runs (leave it open in a tab)",
  usage: `Usage: agent-tasks runner [--every 5m] [--once] [--quiet] [--plain]

A long-lived process: runs a tick every interval, records each event as it
happens (launched, succeeded, failed, missed, blocked…) and sends them to
the notifiers in the config (by default, a desktop notification for
failed, timed_out and blocked). Leave it open in a terminal tab. A tick that
fails is shown as ⚠ and the runner carries on.

On a terminal it shows the dashboard of "agent-tasks top" (what needs
attention, tasks, runs, the runner's events), with Vim keys and the mouse
(? lists the keys; tui.toml in the config folder changes them). q or Ctrl-C
stops the runner after the current tick.

With --plain, or when the screen is not a terminal, it prints one line per
event instead (with a status line at the bottom on a terminal). With
--json, one JSON object per line.

Only one runner runs at a time (state/runner.lock). Every line is also
appended to state/runner.log. On a terminal it reports itself to Herdr
(title and agent state), so task tabs nest under it.

Options:
  --every <duration>  Interval between ticks (default: runner.every in the config, or 5m;
                      read at start, so a change needs a restart)
  --once              Run a single tick and exit
  --quiet             Events only: no tick lines and no status line (no dashboard)
  --plain             One line per event instead of the dashboard`,
  async run(ctx, args) {
    // --next opened this dashboard while the first one was the default; kept so scripts that pass it
    // still work (it can go a release after the swap).
    const { values } = parseCommandArgs(args, { every: { type: "string" }, once: { type: "boolean" }, quiet: { type: "boolean" }, plain: { type: "boolean" }, next: { type: "boolean" } }, { maxPositionals: 0 });
    const every = values.every ?? ctx.config.config.runner?.every ?? BUILTIN_DEFAULTS.runner_every;
    if (!isDuration(every)) throw new UsageError(`--every: invalid duration "${every}" (expected e.g. 30s, 5m or 1h)`);

    const dashboard = !values.plain && !values.once && !values.quiet && !ctx.json && canShowDashboard(ctx.stdout);
    // Read before starting, so a broken tui.toml stops here and not with the screen taken.
    const config = dashboard ? loadTuiConfig(ctx.paths.configDir) : null;
    // Set from a callback, so `as` keeps TypeScript from narrowing it to null.
    let tui = null as AppHandle | null;
    /** The dashboard while it starts (it is async): waited for before giving the terminal back. */
    let starting: Promise<void> | null = null;
    // The screen is the dashboard's from the start (it opens asynchronously, after the first lines are
    // written) until it has given the terminal back; lines meanwhile only go to runner.log.
    let screenTaken = config !== null;

    // The clock is the real time, shifted so that the first tick happens at `--now`.
    const offset = ctx.now.getTime() - Date.now();
    const now = () => new Date(Date.now() + offset);
    const context = (at: Date) => createContext({ now: at, json: ctx.json, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands });
    // The first signal stops after the current tick; a second one exits as soon as the event loop
    // runs again (launcher commands run synchronously, so not while one of them is still running).
    const controller = new AbortController();
    const stop = () => {
      tui?.stop();
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
          now,
          sleep: interruptibleSleep,
          context,
          signal: controller.signal,
          stdout: ctx.stdout,
          pid: process.pid,
          onStarted: () => {
            if (!config) return;
            starting = startDashboard({ title: "agent-tasks runner", config, now, context, env: ctx.env, exec: selfCommand(ctx.env), watchDir: ctx.paths.dataDir, onQuit: stop }).then(
              (handle) => {
                tui = handle;
                if (controller.signal.aborted) handle.stop(); // stopped while it was starting
              },
              (err) => {
                screenTaken = false;
                ctx.stderr.write(`agent-tasks: ${dashboardFailed(err)}; carrying on without it\n`);
              },
            );
          },
          screenHidden: () => screenTaken,
          screenBack: async () => {
            await starting;
            tui?.stop();
            await tui?.closed;
            screenTaken = false;
          },
        },
      );
    } finally {
      await starting;
      tui?.stop();
      await tui?.closed;
      for (const signal of SIGNALS) process.off(signal, stop);
    }
  },
};

export default runner;
