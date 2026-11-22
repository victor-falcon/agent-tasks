import { parseCommandArgs } from "../args.ts";
import { type Context, createContext, output } from "../context.ts";
import { buildDashboard } from "../dashboard.ts";
import { loadTuiConfig } from "../ui/keymap/config.ts";
import { selfCommand } from "../ui/exec.ts";
import { type AppHandle, canShowDashboard, dashboardFailed, startDashboard } from "../ui/load.ts";
import status from "./status.ts";
import type { Command } from "./types.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const top: Command = {
  name: "top",
  summary: "Dashboard: what needs you, tasks, runs and the runner, live (Vim keys, mouse)",
  usage: `Usage: agent-tasks top

A full-screen dashboard, refreshed as things change, in four tabs:
Overview (what needs attention, running now, what's next, recent results),
Tasks, Runs (the whole history, filtered with / and f) and System (the
runner, its events, machines and checks). Open a run to read its result,
output, attempts, events and captured log; open a task for its schedule,
instructions and runs. \`agent-tasks runner\` shows the same dashboard on a
terminal; this command is for watching without running the scheduler
(another tab, another machine).

Keys (Vim style; press ? inside for the full list, or wait after g or z):
  1-4 or gt/gT  tabs             j/k  move (5j: five rows)   gg/G  first/last
  <Tab>/<S-Tab> next section     <CR> or l  open             h, q or <Esc>  back
  /  filter     :  or <C-p>  command palette (actions, tasks, runs)
  a  attach     r  retry     R  run now     p  pause/resume     u  undo
  x  mark a "Needs attention" row as seen     ?  keys     q  quit
Clicks select, a double click opens, the wheel scrolls.

Keys can be changed in tui.toml in the config folder
(~/.config/agent-tasks/tui.toml), in Vim notation (every action and its
default keys: examples/tui.example.toml):

  mouse = false         # leave the mouse to the terminal
  [keys]
  down = ["j", "<Down>"]
  retry = "<C-r>"
  run_now = []          # an empty list unbinds an action

With --json, prints the dashboard's data once and exits. When stdout or
stdin is not a terminal (a pipe, a file), prints what \`agent-tasks status\`
prints and exits 0 (use \`status\` in scripts: its exit code says when
something needs you).`,
  async run(ctx, args) {
    // --next opened this dashboard while the first one was the default; kept so scripts that pass it
    // still work (it can go a release after the swap).
    parseCommandArgs(args, { next: { type: "boolean" } }, { maxPositionals: 0 });
    if (ctx.json) {
      output(ctx, buildDashboard(ctx), "");
      return;
    }
    if (!canShowDashboard(ctx.stdout)) {
      // No screen to draw on: the same overview in plain text.
      await status.run(ctx, []);
      return 0;
    }
    return await showDashboard(ctx);
  },
};

async function showDashboard(ctx: Context): Promise<number> {
  // Read before taking the screen, so a broken tui.toml stops here.
  const config = loadTuiConfig(ctx.paths.configDir);
  // The clock is the real time, shifted so that it starts at `--now`.
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
    try {
      handle = await startDashboard({
        title: "agent-tasks top",
        config,
        now,
        context: (at) => createContext({ now: at, json: false, env: ctx.env, cwd: ctx.cwd, stdout: ctx.stdout, stderr: ctx.stderr, commands: ctx.commands }),
        env: ctx.env,
        exec: selfCommand(ctx.env),
        watchDir: ctx.paths.dataDir,
        onQuit: done,
      });
    } catch (err) {
      ctx.stderr.write(`agent-tasks: ${dashboardFailed(err)}\n`);
      return 1;
    }
    if (finished) handle.stop(); // a signal came while it was starting
    await quit;
    await handle.closed;
    return 0;
  } finally {
    for (const signal of SIGNALS) process.off(signal, done);
  }
}

export default top;
