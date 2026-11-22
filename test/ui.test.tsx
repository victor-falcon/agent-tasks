import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { writeRun } from "../src/store.ts";
import type { CommandRunner } from "../src/ui/exec.ts";
import { buildKeymap, type TuiConfig } from "../src/ui/keymap/config.ts";
import { type AppHandle, mountApp } from "../src/ui/main.tsx";
import { reconcileSelection } from "../src/ui/components/list-navigation.ts";
import { attentionRuns } from "../src/ui/views/overview/model.ts";
import { buildDashboard } from "../src/dashboard.ts";
import { createSeen } from "../src/ui/seen.ts";
import { VIEW_KEYS } from "../src/ui/views/keys.ts";
import { DETAILS, TABS } from "../src/ui/views/registry.tsx";
import { FIXTURE_NOW, FIXTURE_TZ, scheduledRun, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// The new dashboard (src/ui) on OpenTUI's test renderer: the frame, the
// Overview, keys (tui.toml, counts, sequences), mouse, confirm, undo, attach
// and quit. Commands go to a fake runner; nothing touches the real home.

const NOW = new Date(FIXTURE_NOW);
const sink = { write: () => {} };

let home: TempHome;
let setup: TestRendererSetup | null = null;
let handle: AppHandle | null = null;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
});
afterEach(() => {
  handle?.stop();
  handle = null;
  setup = null;
  home.cleanup();
});

interface Started {
  setup: TestRendererSetup;
  handle: AppHandle;
  calls: { args: string[]; interactive: boolean }[];
  quits: () => number;
  /** The screen as text, trailing spaces trimmed. */
  screen(): Promise<string>;
  press(...keys: string[]): Promise<void>;
}

async function start(opts: { width?: number; height?: number; exec?: CommandRunner; config?: Partial<TuiConfig>; env?: Record<string, string> } = {}): Promise<Started> {
  setup = await createTestRenderer({ width: opts.width ?? 160, height: opts.height ?? 40 });
  const calls: Started["calls"] = [];
  let quits = 0;
  const env = { ...home.env, ...opts.env };
  handle = await mountApp(setup.renderer, {
    title: "agent-tasks top",
    config: { keymap: buildKeymap(), mouse: true, file: null, ...opts.config },
    now: () => NOW,
    context: (now) => createContext({ now, json: false, env, cwd: home.root, stdout: sink, stderr: sink, commands }),
    env,
    exec: async (args, o) => {
      calls.push({ args, interactive: o.interactive });
      return opts.exec ? opts.exec(args, o) : { code: 0, output: `did ${args.join(" ")}\n` };
    },
    watchDir: null,
    onQuit: () => quits++,
    waitForKey: async () => {},
    // The test renderer has no real terminal to hand over.
    handOver: { suspend: async () => {}, resume: async () => {} },
  });
  const s = setup;
  const screen = async () => {
    await s.renderOnce();
    return s
      .captureCharFrame()
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
  };
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      if (key === "<CR>") s.mockInput.pressEnter();
      else if (key === "<Tab>") s.mockInput.pressTab();
      else if (key === "<Esc>") {
        s.mockInput.pressEscape();
        await Bun.sleep(60); // a lone Esc is only told from Alt+key after a moment
      }
      else if (key === "<C-c>") s.mockInput.pressCtrlC();
      else if (/^[A-Z]$/.test(key)) s.mockInput.pressKey(key.toLowerCase(), { shift: true });
      else s.mockInput.pressKey(key);
      await Bun.sleep(1);
    }
    await s.renderOnce();
  };
  await s.renderOnce();
  return { setup: s, handle, calls, quits: () => quits, screen, press };
}

/** The selected row (`› …`), trimmed to its first cells. */
function selectedRow(screen: string): string {
  const line = screen.split("\n").find((l) => l.startsWith("› "));
  return line ? line.slice(2, 80).replace(/\s+/g, " ").trim() : "";
}

/** Waits for background commands (the fake runner resolves on the next tick). */
const settle = () => Bun.sleep(5);

describe("frame", () => {
  test("header, tabs, the Overview with its preview, footer (160 columns)", async () => {
    writeFixture(home.paths);
    const { screen } = await start();
    expect(await screen()).toMatchSnapshot();
  });

  test("below 120 columns the preview hides", async () => {
    writeFixture(home.paths);
    const { screen } = await start({ width: 100, height: 30 });
    const text = await screen();
    expect(text).toMatchSnapshot();
    expect(text).not.toContain("│ ! blocked");
  });

  test("no tasks yet", async () => {
    const { screen } = await start({ width: 100, height: 16 });
    expect(await screen()).toMatchSnapshot();
  });

  test("only the terminal's palette: every color is an ANSI index or the default", async () => {
    writeFixture(home.paths);
    const envs: Record<string, string>[] = [{}, { NO_COLOR: "1" }];
    for (const env of envs) {
      const { setup: s } = await start({ env });
      await s.renderOnce();
      const intents = new Set<string>();
      for (const line of s.captureSpans().lines) for (const span of line.spans) intents.add(span.fg.intent).add(span.bg.intent);
      expect([...intents].filter((i) => i !== "indexed" && i !== "default")).toEqual([]);
      if ("NO_COLOR" in env) expect(intents.has("indexed")).toBe(false);
      else expect(intents.has("indexed")).toBe(true);
      handle!.stop();
    }
  });

  test("the tab keys and gt switch tabs", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start();
    await press("2");
    await Bun.sleep(450); // `2` also starts a count (`2j`): it runs alone after a moment
    await settle();
    expect(await screen()).toContain("── Tasks (7)");
    await press("g", "t");
    expect(await screen()).toContain("── History (");
    await press("g", "T", "g", "T");
    expect(await screen()).toContain("Needs attention");
  });
});

describe("Overview keys", () => {
  test("j/k, counts, gg/G and <Tab> between sections", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start();
    expect(selectedRow(await screen())).toStartWith("! review-pr-123 blocked");
    await press("j");
    expect(selectedRow(await screen())).toStartWith("✕ 09:10 sentry-summary");
    await press("5", "j");
    expect(selectedRow(await screen())).toStartWith("◐ worktree-cleanup running");
    await press("<Tab>");
    expect(selectedRow(await screen())).toStartWith("○ 11:00 sentry-summary");
    await press("G");
    expect(selectedRow(await screen())).toContain("weekly-deps-report");
    await press("g", "g");
    expect(selectedRow(await screen())).toStartWith("! review-pr-123");
    await press("k");
    expect(selectedRow(await screen())).toStartWith("! review-pr-123");
  });

  test("keys from tui.toml: remapped keys work and show in the footer", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start({ config: { keymap: buildKeymap({ down: ["n"], retry: "<C-r>" }) } });
    await press("j");
    expect(selectedRow(await screen())).toStartWith("! review-pr-123");
    await press("n");
    expect(selectedRow(await screen())).toStartWith("✕ 09:10 sentry-summary");
    expect(await screen()).toContain("n/k move");
    expect(await screen()).toContain("<C-r> retry");
  });

  test("the selection stays on the same run across a reload", async () => {
    writeFixture(home.paths);
    const { screen, press, handle: h } = await start();
    await press("<Tab>", "<Tab>", "<Tab>", "j");
    const before = selectedRow(await screen());
    expect(before).toContain("sentry-summary");
    // A newer finished run lands at the top of Recent.
    writeRun(home.paths, scheduledRun("inbox-triage", "2026-11-17T09:58:00+01:00", "succeeded", { summary: "a new one", minutes: 1, delayMin: 0 }));
    h.app.store.reload();
    expect(selectedRow(await screen())).toBe(before);
  });

  test("? lists the keys of the view; any key closes it", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start();
    await press("?");
    const text = await screen();
    expect(text).toContain("Keys");
    expect(text).toContain("toggle_pause");
    await press("x");
    expect(await screen()).not.toContain("toggle_pause");
  });
});

describe("actions", () => {
  test("retry asks first: n does nothing, y runs the command and shows its answer", async () => {
    writeFixture(home.paths);
    const { screen, press, calls } = await start();
    await press("j", "r");
    expect(await screen()).toContain("Retry sentry-summary/20261117T080000Z?");
    await press("n");
    expect(await screen()).not.toContain("Retry sentry-summary");
    expect(calls).toEqual([]);
    await press("r", "y");
    await settle();
    expect(calls).toEqual([{ args: ["retry", "sentry-summary/20261117T080000Z"], interactive: false }]);
    expect(await screen()).toContain("did retry sentry-summary/20261117T080000Z");
  });

  test("run now confirms; a run that can't be retried says why", async () => {
    writeFixture(home.paths);
    const { screen, press, calls } = await start();
    await press("r");
    expect(await screen()).toContain("only failed, timed-out or missed runs can be retried");
    await press("<Esc>");
    await press("R");
    expect(await screen()).toContain("Run review-pr-123 now?");
    await press("<CR>"); // the safe answer
    expect(calls).toEqual([]);
  });

  test("pause is instant and u undoes it while its toast shows", async () => {
    writeFixture(home.paths);
    const { screen, press, calls } = await start();
    await press("<Tab>", "<Tab>"); // Next: sentry-summary, active
    await press("p");
    await settle();
    expect(calls.map((c) => c.args)).toEqual([["pause", "sentry-summary"]]);
    expect(await screen()).toContain("did pause sentry-summary · u undo");
    await press("u");
    await settle();
    expect(calls.map((c) => c.args)).toEqual([["pause", "sentry-summary"], ["resume", "sentry-summary"]]);
    await press("u"); // nothing left to undo
    await settle();
    expect(calls.length).toBe(2);
  });

  test("a failed command shows an error toast that stays until dismissed", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start({ exec: async () => ({ code: 1, output: "agent-tasks: no such task\n" }) });
    await press("<Tab>", "<Tab>", "p");
    await settle();
    expect(await screen()).toContain("pausing sentry-summary failed: agent-tasks: no such task");
    await press("<Esc>");
    expect(await screen()).not.toContain("no such task");
  });

  test("attach hands the terminal over and takes it back", async () => {
    writeFixture(home.paths);
    const { screen, press, calls } = await start();
    await press("a");
    await settle();
    expect(calls).toEqual([{ args: ["attach", "review-pr-123/20261117T083000Z"], interactive: true }]);
    expect(await screen()).toContain("Needs attention");
  });

  test("open pushes the run's view; back returns to the same row", async () => {
    writeFixture(home.paths);
    const { screen, press } = await start();
    await press("j", "<CR>");
    expect(await screen()).toContain("sentry-summary/20261117T080000Z  ✕ failed · 3m");
    await press("h");
    expect(selectedRow(await screen())).toStartWith("✕ 09:10 sentry-summary");
  });

  test("q quits through renderer.destroy(); Ctrl-C too", async () => {
    writeFixture(home.paths);
    const first = await start();
    await first.press("q");
    expect(first.quits()).toBe(1);
    expect(first.setup.renderer.isDestroyed).toBe(true);
    const second = await start();
    await second.press("<C-c>");
    expect(second.quits()).toBe(1);
  });
});

describe("mouse", () => {
  test("a click selects, a double click opens, a click on a tab switches", async () => {
    writeFixture(home.paths);
    const { screen, setup: s } = await start();
    const rowOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle));
    let text = await screen();
    const y = rowOf(text, "inbox-triage    –");
    await s.mockMouse.click(10, y);
    expect(selectedRow(await screen())).toContain("inbox-triage");
    await s.mockMouse.doubleClick(10, y);
    expect(await screen()).toContain("inbox-triage/20261117T050000Z  □ missed");
    text = await screen();
    await s.mockMouse.click(text.split("\n")[1]!.indexOf("System"), 1);
    expect(await screen()).toContain("─ Checks");
  });
});

test("the registry and the key specs tui.toml is checked against are the same views", () => {
  const registered = [...Object.values(TABS), ...Object.values(DETAILS)].map((v) => v.keys);
  expect(registered).toEqual([...VIEW_KEYS]);
});

describe("Overview data", () => {
  const ctx = () => createContext({ now: NOW, json: false, env: home.env, cwd: home.root, stdout: sink, stderr: sink, commands });

  test("Needs attention: blocked runs, then failures and missed runs of the last 24 hours not seen", () => {
    writeFixture(home.paths);
    const dash = buildDashboard(ctx());
    const refs = attentionRuns({ dash, now: NOW, timezone: FIXTURE_TZ, seen: createSeen({ file: null, now: () => NOW }) }).map((r) => `${r.status} ${r.ref}`);
    expect(refs[0]).toBe("blocked review-pr-123/20261117T083000Z");
    expect(refs).toContain("failed sentry-summary/20261117T080000Z");
    expect(refs).not.toContain("failed worktree-cleanup/20261113T070000Z"); // last week
    const seen = { isSeen: (ref: string) => ref.startsWith("sentry-summary/20261117T08"), markSeen: () => {} };
    expect(attentionRuns({ dash, now: NOW, timezone: FIXTURE_TZ, seen }).map((r) => r.ref)).not.toContain("sentry-summary/20261117T080000Z");
  });

  test("a selection that disappears moves to the same run elsewhere, else stays in place", () => {
    const sections = [{ rows: [{ key: "running:a" }, { key: "recent:b" }] }, { rows: [{ key: "recent:x" }] }];
    expect(reconcileSelection(sections, "recent:x", [])).toBe("recent:x");
    expect(reconcileSelection([{ rows: [{ key: "recent:a" }] }], "running:a", ["running:a"])).toBe("recent:a");
    expect(reconcileSelection(sections, "running:gone", ["q", "w", "running:gone"])).toBe("recent:x");
    expect(reconcileSelection([], "recent:x", [])).toBeNull();
  });
});
