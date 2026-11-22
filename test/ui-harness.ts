import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import type { CommandRunner } from "../src/tui/app.ts";
import { buildKeymap, type TuiConfig } from "../src/ui/keymap/config.ts";
import { type AppHandle, mountApp } from "../src/ui/main.tsx";
import type { TempHome } from "./helpers.ts";

// The new dashboard mounted on OpenTUI's test renderer, for view tests:
// commands go to a fake runner, the clock is fixed, nothing touches the real
// home. (test/ui.test.tsx has its own copy from before this file; it can move
// here once the parallel view tasks have landed.)

const sink = { write: () => {} };

export interface Started {
  setup: TestRendererSetup;
  handle: AppHandle;
  calls: { args: string[]; interactive: boolean }[];
  /** The screen as text, trailing spaces trimmed. */
  screen(): Promise<string>;
  /** Presses keys in order (`<CR>`, `<Tab>`, `<Esc>`, `G` for shift+g, plain characters). */
  press(...keys: string[]): Promise<void>;
  stop(): void;
}

export interface StartOptions {
  width?: number;
  height?: number;
  exec?: CommandRunner;
  config?: Partial<TuiConfig>;
}

export async function startApp(home: TempHome, now: Date, opts: StartOptions = {}): Promise<Started> {
  const setup = await createTestRenderer({ width: opts.width ?? 160, height: opts.height ?? 40 });
  const calls: Started["calls"] = [];
  const env = home.env;
  const handle = await mountApp(setup.renderer, {
    title: "agent-tasks top",
    config: { keymap: buildKeymap(), mouse: true, file: null, ...opts.config },
    now: () => now,
    context: (at) => createContext({ now: at, json: false, env, cwd: home.root, stdout: sink, stderr: sink, commands }),
    env,
    exec: async (args, o) => {
      calls.push({ args, interactive: o.interactive });
      return opts.exec ? opts.exec(args, o) : { code: 0, output: `did ${args.join(" ")}\n` };
    },
    watchDir: null,
    onQuit: () => {},
    waitForKey: async () => {},
    handOver: { suspend: async () => {}, resume: async () => {} },
  });
  const screen = async () => {
    await setup.renderOnce();
    return setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      if (key === "<CR>") setup.mockInput.pressEnter();
      else if (key === "<Tab>") setup.mockInput.pressTab();
      else if (key === "<Esc>") {
        setup.mockInput.pressEscape();
        await Bun.sleep(60); // a lone Esc is only told from Alt+key after a moment
      } else if (/^[A-Z]$/.test(key)) setup.mockInput.pressKey(key.toLowerCase(), { shift: true });
      else setup.mockInput.pressKey(key);
      await Bun.sleep(1);
    }
    await setup.renderOnce();
  };
  await setup.renderOnce();
  return { setup, handle, calls, screen, press, stop: () => handle.stop() };
}

/** The selected row (`› …`) without the preview beside it, its cells joined by single spaces. */
export function selectedRow(screen: string): string {
  const line = screen.split("\n").find((l) => l.startsWith("› "));
  return line ? line.slice(2).split("│")[0]!.replace(/\s+/g, " ").trim() : "";
}

/** Waits for background commands (the fake runner resolves on the next tick). */
export const settle = () => Bun.sleep(5);
