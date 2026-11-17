import type { Context } from "../context.ts";
import { processTerminal, selfCommand, Tui } from "./app.ts";
import type { Keymap } from "./keys.ts";

export { loadKeymap } from "./keys.ts";
export { buildDashboard } from "./snapshot.ts";

export interface StartOptions {
  title: string;
  keymap: { keymap: Keymap; file: string | null };
  now(): Date;
  context(now: Date): Context;
  env: Record<string, string | undefined>;
  watchDir: string | null;
  onQuit(): void;
}

/** Whether this process can show the dashboard: stdout and stdin are a terminal. */
export function canShowDashboard(stdout: { isTTY?: boolean }): boolean {
  return stdout.isTTY === true && process.stdin.isTTY === true;
}

/** Opens the dashboard on this process's terminal. Call `stop()` on the result to give the terminal back. */
export function startDashboard(opts: StartOptions): Tui {
  const tui = new Tui({
    title: opts.title,
    keymap: opts.keymap.keymap,
    keymapFile: opts.keymap.file,
    now: opts.now,
    context: opts.context,
    terminal: processTerminal(),
    env: opts.env,
    exec: selfCommand(opts.env),
    onQuit: opts.onQuit,
    watchDir: opts.watchDir,
  });
  tui.start();
  return tui;
}
