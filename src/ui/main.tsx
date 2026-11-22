import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { join } from "node:path";
import { render } from "@opentui/solid";
import type { Context } from "../context.ts";
import type { CommandRunner } from "./exec.ts";
import { createActions } from "./actions.ts";
import { Frame } from "./app.tsx";
import { type App, AppContext } from "./context.ts";
import { COUNTED_ACTIONS } from "./keymap/actions.ts";
import type { TuiConfig } from "./keymap/config.ts";
import { createCount } from "./keymap/count.ts";
import { actionOfKey, createAppKeymap } from "./keymap/vim.ts";
import { createSeen } from "./seen.ts";
import { createUiState, TAB_IDS } from "./state.ts";
import { createStore } from "./store.ts";
import { createSuspend, type HandOver, waitForTerminalKey } from "./terminal.ts";
import { createTheme, paletteGuard } from "./theme.ts";
import { TABS } from "./views/registry.tsx";

// Starting the dashboard: a renderer on this terminal (or a test
// renderer), the store, the keymap and the actions, and the frame mounted
// on it. Quitting goes through renderer.destroy(), which gives the terminal
// back; the caller waits for `closed` before the process exits.

export interface AppOptions {
  /** `agent-tasks top` or `agent-tasks runner`. */
  title: string;
  config: TuiConfig;
  /** The clock (the real time, shifted by `--now`). */
  now(): Date;
  /** A fresh context at `now` (config re-read). */
  context(now: Date): Context;
  env: Record<string, string | undefined>;
  exec: CommandRunner;
  /** Folder to watch for changes (the data folder); null to rely on the reload timer. */
  watchDir: string | null;
  /** The user quit (q, Ctrl-C); the renderer is already destroyed. */
  onQuit(): void;
  /** After a command that had the terminal fails: wait for a key so its error can be read. */
  waitForKey?: () => Promise<void>;
  /** How the terminal is handed to a command (attach) and taken back: the renderer's suspend/resume unless replaced (tests). */
  handOver?: HandOver;
  /** Runs a program with the terminal (the pager): Bun.spawn unless replaced (tests). */
  spawn?: (argv: string[]) => Promise<number>;
  /** Puts text on the clipboard (`y`): OSC 52 through the renderer unless replaced (tests). */
  copy?: (text: string) => boolean;
}

export interface AppHandle {
  app: App;
  /** Leaves the dashboard (as quitting does). Safe to call more than once. */
  stop(): void;
  readonly isRunning: boolean;
  /** Settles once the terminal is given back. */
  closed: Promise<void>;
}

export async function mountApp(renderer: CliRenderer, opts: AppOptions): Promise<AppHandle> {
  const theme = createTheme(opts.env, renderer);
  renderer.addPostProcessFn(paletteGuard);
  const keymap = createAppKeymap(renderer);
  const store = createStore(opts);
  const ui = createUiState();
  const count = createCount(keymap, {
    enabled: () => !ui.modal(),
    counted: (event) => actionOfKey(event, opts.config.keymap, COUNTED_ACTIONS) !== null,
  });
  let running = true;

  const stop = () => {
    if (!running) return;
    running = false;
    store.stop();
    ui.dispose();
    count.dispose();
    renderer.destroy();
  };
  const quit = () => {
    if (!running) return;
    stop();
    opts.onQuit();
  };

  const suspend = createSuspend({ handOver: opts.handOver ?? renderer, store, waitForKey: opts.waitForKey ?? waitForTerminalKey, running: () => running });

  const actions = createActions({
    store,
    ui,
    keymap: opts.config.keymap,
    exec: opts.exec,
    suspend,
    quit,
    spawn: opts.spawn,
    env: opts.env,
    copy: opts.copy ?? ((text) => renderer.copyToClipboardOSC52(text)),
  });
  const cycle = (by: number) => () => ui.setTab(TAB_IDS[(TAB_IDS.indexOf(ui.tab()) + by + TAB_IDS.length) % TAB_IDS.length]!);
  const globalHandlers: App["globalHandlers"] = {
    // Each tab's own action (tab_overview…), from the registry.
    ...Object.fromEntries(TAB_IDS.map((id) => [TABS[id].action, () => ui.setTab(id)])),
    next_tab: cycle(1),
    prev_tab: cycle(-1),
    refresh: () => store.reload(),
    help: () => ui.setHelp(true),
    palette: () => ui.setPalette(true),
    undo: () => actions.undo(),
    dismiss: () => ui.dismiss(),
    back: () => void ui.pop(),
    quit: () => actions.quit(),
  };

  const seen = createSeen({ file: seenFile(opts), now: opts.now, changed: store.version });
  const app: App = { title: opts.title, renderer, store, ui, actions, theme, config: opts.config, keymap, count, seen, globalHandlers };

  // Ctrl-C always quits, whatever tui.toml says and whatever is open.
  keymap.intercept(
    "key",
    (ctx) => {
      if (ctx.event.ctrl && ctx.event.name === "c") {
        ctx.consume();
        quit();
      }
    },
    { priority: 1000 },
  );

  store.start();
  await render(
    () => (
      <AppContext.Provider value={app}>
        <Frame />
      </AppContext.Provider>
    ),
    renderer,
  );
  return {
    app,
    stop,
    get isRunning() {
      return running;
    },
    closed: renderer.closed ?? Promise.resolve(),
  };
}

/** state/tui.json in the data folder this dashboard reads, or null when the config cannot be read (the store reports why). */
function seenFile(opts: AppOptions): string | null {
  try {
    return join(opts.context(opts.now()).paths.stateDir, "tui.json");
  } catch {
    return null;
  }
}

/** Opens the dashboard on this process's terminal. */
export async function startApp(opts: AppOptions): Promise<AppHandle> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: opts.config.mouse,
    autoFocus: false,
    targetFps: 30,
    openConsoleOnError: false,
  });
  return await mountApp(renderer, opts);
}
