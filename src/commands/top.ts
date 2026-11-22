import { parseCommandArgs } from "../args.ts";
import { type Context, createContext, output } from "../context.ts";
import { stdoutStyle } from "../output/style.ts";
import { displayTimezone } from "../task-info.ts";
import { initialState, renderFrame } from "../tui/render.ts";
import { buildDashboard, canShowDashboard, loadKeymap, startDashboard } from "../tui/index.ts";
import { selfCommand } from "../tui/app.ts";
import { loadTuiConfig } from "../ui/keymap/config.ts";
import { type AppHandle, startNewDashboard } from "../ui/load.ts";
import type { Command } from "./types.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** Size of the single frame printed when stdout is not a terminal. */
const PLAIN_FRAME = { width: 100, height: 30 };

const top: Command = {
  name: "top",
  summary: "Dashboard: what runs, what's next, recent results and their output (Vim keys)",
  usage: `Usage: agent-tasks top

A full-screen dashboard, refreshed as things change: the runner's health,
runs in progress, the next run of every task, recent results with their
summary, and the runner's events (state/runner.log). Open a run to read its
result (its summary and the file it passed to --output-file); its details,
attempts, events and the log captured from its session are folded below.
\`agent-tasks runner\` shows the same dashboard on a terminal; this command
is for watching without running the scheduler (another tab, another
machine).

Keys (Vim style; press ? inside for the full list):
  j/k  move        gg/G  first/last       <C-d>/<C-u>  half a page
  <Tab>/<S-Tab>  next/previous panel      <CR> or l    open the run
  In a run, j/k move between its sections (and scroll a long open one),
  <CR>, <Space> or za open/fold the selected one, zR/zM all of them,
  {/} jump to the previous/next section, h, q or <Esc> go back
  a  attach to the session   r  retry   R  run the task now   p  pause/resume
  ?  keys    q  quit

Keys can be changed in tui.toml in the config folder
(~/.config/agent-tasks/tui.toml), in Vim notation:

  [keys]
  down = ["j", "<Down>"]
  retry = "<C-r>"
  run_now = []          # an empty list unbinds an action

With --json, prints the data once and exits. When stdout is not a terminal,
prints a single frame.`,
  async run(ctx, args) {
    // --next: the new dashboard (src/ui), not documented until it replaces this one.
    const { values } = parseCommandArgs(args, { next: { type: "boolean" } }, { maxPositionals: 0 });
    if (ctx.json) {
      output(ctx, buildDashboard(ctx), "");
      return;
    }
    if (values.next && canShowDashboard(ctx.stdout)) return await topNext(ctx);
    const keymap = loadKeymap(ctx.paths.configDir);
    if (!canShowDashboard(ctx.stdout)) {
      const frame = renderFrame({
        dash: buildDashboard(ctx),
        state: initialState(),
        keymap: keymap.keymap,
        keymapFile: keymap.file,
        ...PLAIN_FRAME,
        style: stdoutStyle(ctx),
        timezone: displayTimezone(ctx),
        now: ctx.now,
        title: "agent-tasks top",
      });
      ctx.stdout.write(`${frame.map((l) => l.trimEnd()).join("\n")}\n`);
      return;
    }
    // The clock is the real time, shifted so that it starts at `--now`.
    const offset = ctx.now.getTime() - Date.now();
    const now = () => new Date(Date.now() + offset);
    return await new Promise<number>((resolve) => {
      const done = () => {
        for (const signal of SIGNALS) process.off(signal, onSignal);
        tui.stop();
        resolve(0);
      };
      const onSignal = () => done();
      for (const signal of SIGNALS) process.on(signal, onSignal);
      const tui = startDashboard({
        title: "agent-tasks top",
        keymap,
        now,
        context: (at) => createContext({ now: at, json: false, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands }),
        env: ctx.env,
        watchDir: ctx.paths.dataDir,
        onQuit: done,
      });
    });
  },
};

/** `top --next`: the new dashboard, until the old one goes. */
async function topNext(ctx: Context): Promise<number> {
  // Read before taking the screen, so a broken tui.toml stops here.
  const config = loadTuiConfig(ctx.paths.configDir);
  const offset = ctx.now.getTime() - Date.now();
  const now = () => new Date(Date.now() + offset);
  let handle: AppHandle | null = null;
  let finished = false;
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => (resolveQuit = resolve));
  const done = () => {
    if (finished) return;
    finished = true;
    handle?.stop();
    resolveQuit();
  };
  for (const signal of SIGNALS) process.on(signal, done);
  try {
    handle = await startNewDashboard({
      title: "agent-tasks top",
      config,
      now,
      context: (at) => createContext({ now: at, json: false, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands }),
      env: ctx.env,
      exec: selfCommand(ctx.env),
      watchDir: ctx.paths.dataDir,
      onQuit: done,
    });
    if (finished) handle.stop(); // a signal came while it was starting
    await quit;
    await handle.closed;
    return 0;
  } finally {
    for (const signal of SIGNALS) process.off(signal, done);
  }
}

export default top;
