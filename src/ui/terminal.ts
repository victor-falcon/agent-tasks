import type { Store } from "./store.ts";

// Handing the terminal to a command that needs it (attach) and taking it
// back: the renderer suspends (leaves the alternate screen, gives up raw
// input), the command runs, and if it failed its error stays on screen until
// a key is pressed.

export interface HandOver {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

/** One key from the real terminal, in raw mode. */
export function waitForTerminalKey(): Promise<void> {
  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      resolve();
    });
  });
}

export interface SuspendOptions {
  handOver: HandOver;
  store: Store;
  waitForKey(): Promise<void>;
  /** False once the dashboard was stopped meanwhile: it is not resumed. */
  running(): boolean;
}

/** `run` with the terminal; its exit code decides whether to wait for a key. */
export function createSuspend(opts: SuspendOptions): (run: () => Promise<number>) => Promise<void> {
  return async (run) => {
    opts.store.setPaused(true);
    await opts.handOver.suspend();
    let code: number;
    try {
      code = await run();
    } catch (err) {
      code = 1;
      process.stdout.write(`agent-tasks: ${(err as Error).message}\n`);
    }
    if (code !== 0) {
      // Leave its error on screen until a key is pressed.
      process.stdout.write("\nPress any key to go back to the dashboard…");
      await opts.waitForKey();
    }
    opts.store.setPaused(false);
    if (!opts.running()) return;
    await opts.handOver.resume();
    opts.store.reload();
  };
}
