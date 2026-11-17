import { parseCommandArgs } from "../args.ts";
import { BUILTIN_DEFAULTS } from "../config.ts";
import { createContext } from "../context.ts";
import { isDuration } from "../duration.ts";
import { UsageError } from "../errors.ts";
import { interruptibleSleep, runRunner } from "../runner.ts";
import { releaseRunnerLock } from "../runner-lock.ts";
import { RunnerTui } from "../tui/screen.ts";
import type { Command } from "./types.ts";

/** Ctrl-C, kill, and the terminal tab closing. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const runner: Command = {
  name: "runner",
  summary: "Keep ticking every few minutes and show what runs (leave it open in a tab)",
  usage: `Usage: agent-tasks runner [--every 5m] [--once] [--quiet] [--plain]

A plain long-lived process: runs a tick every interval, shows each event as
it happens (launched, succeeded, failed, missed, blocked…) and sends them to
the notifiers in the config (by default, a desktop notification for
failed, timed_out and blocked). Leave it open in a terminal tab. A tick that
fails is shown as ⚠ and the runner carries on. Ctrl-C stops it after the
current tick.

On a terminal (stdin and stdout), it shows a full-screen view: the runner's
state at the top; Recent runs, Upcoming slots and Tasks (with their last 10
results) on the left; the selected item's detail on the right; the latest
event at the bottom. Keys: j/k move, gg/G top/bottom, Ctrl-d/Ctrl-u half a
page, Tab/Shift-Tab or 1/2/3 switch panels, l/h detail and back, Enter opens
the run's log (followed while it runs), / filters by task id (n/N next and
previous match), ? help, q quits (like Ctrl-C).

Otherwise (piped, --plain, --quiet, --json or --once) it prints one line
per event and, on a terminal, keeps a status line at the bottom.

Only one runner runs at a time (state/runner.lock). Every line is also
appended to state/runner.log, whatever the output. On a terminal, it reports
itself to Herdr (title and agent state), so task tabs nest under it. With
--json, it prints one JSON object per line.

Options:
  --every <duration>  Interval between ticks (default: runner.every in the config, or 5m;
                      read at start, so a change needs a restart)
  --once              Run a single tick and exit
  --quiet             Events only: no tick lines and no status line
  --plain             One line per event even on a terminal (no full-screen view)`,
  async run(ctx, args) {
    const { values } = parseCommandArgs(args, { every: { type: "string" }, once: { type: "boolean" }, quiet: { type: "boolean" }, plain: { type: "boolean" } }, { maxPositionals: 0 });
    const every = values.every ?? ctx.config.config.runner?.every ?? BUILTIN_DEFAULTS.runner_every;
    if (!isDuration(every)) throw new UsageError(`--every: invalid duration "${every}" (expected e.g. 30s, 5m or 1h)`);

    // The clock is the real time, shifted so that the first tick happens at `--now`.
    const offset = ctx.now.getTime() - Date.now();
    // The first signal stops after the current tick; a second one exits as soon as the event loop
    // runs again (launcher commands run synchronously, so not while one of them is still running).
    const controller = new AbortController();
    let view: RunnerTui | undefined;
    const stop = () => {
      if (!controller.signal.aborted) return controller.abort();
      view?.close();
      releaseRunnerLock(ctx.paths, process.pid);
      ctx.stderr.write("agent-tasks: stopped in the middle of a tick\n");
      process.exit(130);
    };
    for (const signal of SIGNALS) process.on(signal, stop);
    const now = () => new Date(Date.now() + offset);
    const context = (at: Date) => createContext({ now: at, json: ctx.json, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands });
    const once = values.once ?? false;
    const quiet = values.quiet ?? false;
    const fullScreen = process.stdin.isTTY === true && ctx.stdout.isTTY === true && !ctx.json && !once && !quiet && values.plain !== true;
    view = fullScreen
      ? new RunnerTui({ stdin: process.stdin, stdout: process.stdout, env: ctx.env, every, now, context, onQuit: stop })
      : undefined;
    try {
      return await runRunner(
        ctx,
        { every, once, quiet },
        { now, sleep: interruptibleSleep, context, signal: controller.signal, stdout: ctx.stdout, pid: process.pid, view },
      );
    } finally {
      view?.close();
      for (const signal of SIGNALS) process.off(signal, stop);
    }
  },
};

export default runner;
