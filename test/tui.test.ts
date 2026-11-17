import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { ConfigError } from "../src/errors.ts";
import { createStyle } from "../src/output/style.ts";
import { runnerLogPath } from "../src/runner-lock.ts";
import { writeRun } from "../src/store.ts";
import { type CommandRunner, Tui, type TuiTerminal } from "../src/tui/app.ts";
import { buildKeymap, decodeKeys, DEFAULT_KEYS, KeyMatcher, loadKeymap, parseKeys } from "../src/tui/keys.ts";
import { initialState, renderFrame } from "../src/tui/render.ts";
import { buildDashboard } from "../src/tui/snapshot.ts";
import { fit, sanitize, wrap } from "../src/tui/text.ts";
import { FIXTURE_NOW, FIXTURE_TZ, scheduledRun, writeFixture } from "./fixtures/views.ts";
import { makeTask, makeTempHome, type TempHome } from "./helpers.ts";

// The dashboard (`agent-tasks top`, and `runner` on a terminal): key
// bindings, its data, its frames and the interactive loop with a fake
// terminal.

const NOW = new Date(FIXTURE_NOW);

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
});
afterEach(() => home.cleanup());

const sink = { write: () => {} };
const context = (now = NOW) => createContext({ now, json: false, env: { ...home.env, NO_COLOR: "1" }, cwd: home.root, stdout: sink, stderr: sink, commands });

describe("key notation", () => {
  test("bindings split into canonical keys", () => {
    expect(parseKeys("j")).toEqual(["j"]);
    expect(parseKeys("gg")).toEqual(["g", "g"]);
    expect(parseKeys("<C-w>j")).toEqual(["<C-w>", "j"]);
    expect(parseKeys("<c-D>")).toEqual(["<C-d>"]);
    expect(parseKeys("<enter>")).toEqual(["<CR>"]);
    expect(parseKeys("<s-tab>")).toEqual(["<S-Tab>"]);
    expect(parseKeys("<lt>")).toEqual(["<"]);
    expect(parseKeys("}")).toEqual(["}"]);
  });

  test("unknown keys are refused", () => {
    expect(() => parseKeys("<Foo>")).toThrow("unknown key <Foo>");
    expect(() => parseKeys("<C-1>")).toThrow("only <C-a> to <C-z>");
    expect(() => parseKeys("g g")).toThrow("<Space>");
    expect(() => parseKeys("<C-d")).toThrow('"<" without a closing ">"');
  });

  test("terminal input decodes to the same names", () => {
    expect(decodeKeys("jk")).toEqual(["j", "k"]);
    expect(decodeKeys("\x1b[A\x1b[B\x1bOA")).toEqual(["<Up>", "<Down>", "<Up>"]);
    expect(decodeKeys("\r\t\x1b[Z\x04\x15\x7f ")).toEqual(["<CR>", "<Tab>", "<S-Tab>", "<C-d>", "<C-u>", "<BS>", "<Space>"]);
    expect(decodeKeys("\x1b")).toEqual(["<Esc>"]);
    expect(decodeKeys("\x1b[5~\x1b[6~\x1b[H\x1b[F")).toEqual(["<PageUp>", "<PageDown>", "<Home>", "<End>"]);
    expect(decodeKeys("G}")).toEqual(["G", "}"]);
  });
});

describe("keymap", () => {
  test("an override replaces the action's default keys; [] unbinds it", () => {
    const keymap = buildKeymap({ retry: "<C-r>", run_now: [] });
    expect(keymap.retry.map((b) => b.text)).toEqual(["<C-r>"]);
    expect(keymap.run_now).toEqual([]);
    expect(keymap.down.map((b) => b.text)).toEqual(["j", "<Down>"]);
  });

  test("unknown actions, bad values and conflicts are errors", () => {
    expect(() => buildKeymap({ jump: "x" })).toThrow("unknown action");
    expect(() => buildKeymap({ down: 5 })).toThrow("expected a key or a list of keys");
    expect(() => buildKeymap({ retry: "j" })).toThrow('"j" is bound to both');
    expect(() => buildKeymap({ retry: "g" })).toThrow('"g" (retry) hides "gg" (first)');
  });

  test("the same key may do different things in different views", () => {
    // q quits the panels and closes a run: quit is not active in the run view.
    expect(() => buildKeymap()).not.toThrow();
  });

  test("tui.toml in the config folder", () => {
    expect(loadKeymap(home.configDir).file).toBeNull();
    const file = join(home.configDir, "tui.toml");
    writeFileSync(file, '[keys]\ndown = ["n", "<Down>"]\nup = "e"\n');
    const loaded = loadKeymap(home.configDir);
    expect(loaded.file).toBe(file);
    expect(loaded.keymap.down.map((b) => b.text)).toEqual(["n", "<Down>"]);

    writeFileSync(file, "[keys]\nretry = 'j'\n");
    expect(() => loadKeymap(home.configDir)).toThrow(ConfigError);
    writeFileSync(file, "[keys\n");
    expect(() => loadKeymap(home.configDir)).toThrow("invalid TOML");
    writeFileSync(file, "[colors]\nx = 1\n");
    expect(() => loadKeymap(home.configDir)).toThrow("colors: unknown setting");
  });

  test("sequences wait for the next key; a dead end is dropped", () => {
    const matcher = new KeyMatcher(buildKeymap());
    expect(matcher.feed("g", "list")).toEqual({ kind: "pending" });
    expect(matcher.pendingText).toBe("g");
    expect(matcher.feed("g", "list")).toEqual({ kind: "action", action: "first" });
    expect(matcher.feed("g", "list")).toEqual({ kind: "pending" });
    expect(matcher.feed("x", "list")).toEqual({ kind: "none" });
    expect(matcher.hasPending).toBe(false);
    expect(matcher.feed("<C-w>", "list")).toEqual({ kind: "pending" });
    expect(matcher.feed("j", "list")).toEqual({ kind: "action", action: "next_panel" });
    expect(matcher.feed("q", "list")).toEqual({ kind: "action", action: "quit" });
    expect(matcher.feed("q", "detail")).toEqual({ kind: "action", action: "back" });
  });
});

describe("text", () => {
  test("captured output loses escapes and control characters", () => {
    expect(sanitize("\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 100%\n\tx\x07")).toBe("ok\nprogress 100%\n    x");
  });

  test("wrap and fit", () => {
    expect(wrap("abcdef\nab", 4)).toEqual(["abcd", "ef", "ab"]);
    expect(wrap("hello big world of words", 10)).toEqual(["hello big", "world of", "words"]);
    expect(wrap("  - an indented bullet", 14)).toEqual(["  - an", "  indented", "  bullet"]);
    expect(fit("abc", 5)).toBe("abc  ");
    expect(fit("abcdef", 4)).toBe("abc…");
    const styled = createStyle(true).paint("red", "abcdef");
    expect(fit(styled, 4)).toBe("\x1b[31mabc…\x1b[0m");
  });
});

describe("dashboard data", () => {
  test("running, next (paused last), recent newest first, today's counts", () => {
    writeFixture(home.paths);
    const dash = buildDashboard(context());
    expect(dash.running.map((r) => [r.task_id, r.status])).toEqual([
      ["review-pr-123", "blocked"],
      ["worktree-cleanup", "running"],
      ["sentry-summary", "running"],
    ]);
    expect(dash.next.at(-1)).toMatchObject({ task_id: "backup-notes", state: "paused", at: null });
    expect(dash.next[0]).toMatchObject({ task_id: "sentry-summary", state: "active" });
    const times = dash.recent.map((r) => Date.parse(r.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(dash.recent.some((r) => r.status === "superseded" || r.status === "cancelled")).toBe(false);
    expect(dash.today).toEqual({ succeeded: 3, failed: 1, missed: 4, blocked: 1 });
  });

  test("events are the tail of runner.log", () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLogPath(home.paths), Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const { events } = buildDashboard(context());
    expect(events.length).toBe(200);
    expect(events.at(-1)).toBe("line 299");
  });

  test("top --json prints it once", async () => {
    writeFixture(home.paths);
    let stdout = "";
    const code = await main(["top", "--json", `--now=${FIXTURE_NOW}`], { env: home.env, cwd: home.root, stdout: { write: (t) => void (stdout += t) }, stderr: sink });
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(json.schema).toBe(1);
    expect(Object.keys(json)).toEqual(expect.arrayContaining(["runner", "running", "next", "recent", "today", "events"]));
  });
});

describe("frames", () => {
  const frame = (state = initialState(), size = { width: 100, height: 30 }) => {
    const ctx = context();
    return renderFrame({ dash: buildDashboard(ctx), state, keymap: buildKeymap(), keymapFile: null, ...size, style: createStyle(false), timezone: FIXTURE_TZ, now: NOW, title: "agent-tasks top" });
  };

  test("every line is exactly the width (the last one a column short)", () => {
    writeFixture(home.paths);
    for (const size of [{ width: 100, height: 30 }, { width: 40, height: 12 }, { width: 160, height: 60 }]) {
      const lines = frame(initialState(), size);
      expect(lines.length).toBe(size.height);
      lines.forEach((l, i) => expect(Bun.stringWidth(l)).toBe(i === lines.length - 1 ? size.width - 1 : size.width));
    }
  });

  test("the panels", () => {
    writeFixture(home.paths);
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(runnerLogPath(home.paths), "09:55:01  tick  1 due · 1 running\n09:55:01  ▶ sentry-summary/20261117T085500Z      launched in t45\n");
    expect(frame().map((l) => l.trimEnd()).join("\n")).toMatchSnapshot();
  });

  test("no tasks yet", () => {
    expect(frame().map((l) => l.trimEnd()).join("\n")).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// The interactive loop
// ---------------------------------------------------------------------------

class FakeTerminal implements TuiTerminal {
  out = "";
  input: ((data: string) => void) | null = null;
  constructor(public width = 100, public height = 30) {}
  write(text: string) {
    this.out += text;
  }
  size() {
    return { width: this.width, height: this.height };
  }
  onResize() {
    return () => {};
  }
  readInput(listener: (data: string) => void) {
    this.input = listener;
    return () => {
      if (this.input === listener) this.input = null;
    };
  }
  type(data: string) {
    this.input!(data);
  }
  /** The last frame drawn, trimmed. */
  get screen(): string {
    const frame = this.out.slice(this.out.lastIndexOf("\x1b[H") + 3).replace(/\x1b\[J$/, "");
    return frame
      .split("\r\n")
      .map((l) => l.trimEnd())
      .join("\n");
  }
}

function startTui(exec: CommandRunner = async () => ({ code: 0, output: "" })) {
  const terminal = new FakeTerminal();
  let quit = 0;
  const calls: { args: string[]; interactive: boolean }[] = [];
  const tui = new Tui({
    title: "agent-tasks top",
    keymap: buildKeymap(),
    keymapFile: null,
    now: () => NOW,
    context: (now) => context(now),
    terminal,
    env: { NO_COLOR: "1" },
    exec: async (args, opts) => {
      calls.push({ args, interactive: opts.interactive });
      return exec(args, opts);
    },
    onQuit: () => quit++,
    watchDir: null,
  });
  tui.start();
  return { tui, terminal, calls, quits: () => quit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("interactive", () => {
  test("takes the alternate screen and gives it back on q", () => {
    writeFixture(home.paths);
    const { terminal, quits } = startTui();
    expect(terminal.out.startsWith("\x1b[?1049h")).toBe(true);
    terminal.type("q");
    expect(quits()).toBe(1);
    expect(terminal.out.endsWith("\x1b[?25h\x1b[?1049l")).toBe(true);
    expect(terminal.input).toBeNull();
  });

  test("Ctrl-C quits whatever the keymap says", () => {
    const { terminal, quits } = startTui();
    terminal.type("\x03");
    expect(quits()).toBe(1);
  });

  test("moves in a panel, switches panels and opens a run", () => {
    writeFixture(home.paths);
    const { tui, terminal } = startTui();
    terminal.type("j");
    expect(terminal.screen).toContain("› ■  08:37");
    terminal.type("G");
    terminal.type("gg");
    expect(terminal.screen).toContain("› ✕  09:10");
    terminal.type("\t"); // Recent → Running (panels go Running, Next, Recent and wrap)
    expect(terminal.screen).toMatch(/› !\s+review-pr-123/);
    terminal.type("\r");
    expect(terminal.screen.split("\n")[0]).toMatch(/^review-pr-123\/\S+ +! blocked/);
    expect(terminal.screen).toContain("▾ Result ");
    expect(terminal.screen).toContain("▸ Events · 2 events");
    terminal.type("q"); // back, not quit
    expect(terminal.screen).toContain("── Recent");
    tui.stop();
  });

  test("a run opens on its result; the other sections are folded and <CR> opens them", () => {
    const run = scheduledRun("report", "2026-11-17T08:00:00+01:00", "succeeded", { summary: "report in notes/report.md" });
    run.attempts[0]!.output = "runs/report/out.md";
    home.writeTask(makeTask({ id: "report", title: "Daily report" }));
    writeRun(home.paths, run);
    writeFileSync(join(home.dataDir, "runs/report/out.md"), "# Report\n\nAll good.\n");
    writeFileSync(join(home.dataDir, run.attempts[0]!.log!), "\x1b[1mworking\x1b[0m\ndone\n");
    const { tui, terminal } = startTui();
    terminal.type("\r");
    const heads = () => terminal.screen.split("\n").filter((l) => /^[▾▸] /.test(l)).map((l) => l.replace(/ ─+$/, ""));
    const screen = terminal.screen;
    expect(screen.split("\n")[1]).toMatch(/^▾ Result/);
    expect(screen).toContain("report in notes/report.md");
    expect(screen).toContain("All good.");
    expect(screen).not.toContain("working");
    expect(heads()).toEqual([
      "▾ Result",
      "▾ Output · ~/data/runs/report/out.md",
      "▸ Details · Daily report · ~/Projects/foo",
      "▸ Attempts · 1 attempt",
      "▸ Events · 2 events · last: launched",
      `▸ Log · 2 lines · ~/data/${run.attempts[0]!.log!}`,
    ]);
    // } moves to the next section; <CR> opens it and scrolls to it.
    for (let i = 0; i < 5; i++) terminal.type("}");
    terminal.type("\r");
    expect(terminal.screen).toContain("working\ndone");
    terminal.height = 4; // short enough for the log to reach the top
    terminal.type("{");
    terminal.type("}");
    expect(terminal.screen.split("\n")[1]).toMatch(/^▾ Log/);
    terminal.height = 30;
    for (let i = 0; i < 3; i++) terminal.type("{");
    terminal.type(" ");
    expect(terminal.screen).toContain("Folder    ~/Projects/foo");
    // Folding the result hides it; zR opens everything, zM folds everything.
    terminal.type("gg");
    terminal.type("za");
    expect(terminal.screen).not.toContain("report in notes/report.md");
    terminal.type("zM");
    expect(heads().every((h) => h.startsWith("▸"))).toBe(true);
    terminal.type("zR");
    expect(heads().every((h) => h.startsWith("▾"))).toBe(true);
    tui.stop();
  });

  test("a run with no result yet opens its log", () => {
    const run = scheduledRun("report", "2026-11-17T08:00:00+01:00", "failed", {});
    home.writeTask(makeTask({ id: "report", title: "Daily report" }));
    writeRun(home.paths, run);
    writeFileSync(join(home.dataDir, run.attempts[0]!.log!), "Error: no credentials\n");
    const { tui, terminal } = startTui();
    terminal.type("\r");
    expect(terminal.screen).toContain("The agent reported no summary. Its log is below.");
    expect(terminal.screen).toContain("Error: no credentials");
    tui.stop();
  });

  test("the Events panel shows runner.log in columns, with the runner's own lines", () => {
    mkdirSync(home.paths.stateDir, { recursive: true });
    writeFileSync(
      runnerLogPath(home.paths),
      [
        "agent-tasks runner · every 5m · launcher: herdr (claude) · data: ~/data",
        "13:07:15  tick  1 due · 1 running",
        "13:07:15  ▶ x-autopost/20261117T120700Z          launched in t6q",
        '13:12:15  ■ x-autopost/20261117T120700Z          succeeded in 15s · "Nothing to post today"',
        "13:13:15  ✕ zancada/20261117T120000Z             failed (exit 1) in 3s · boom · agent-tasks log zancada/20261117T120000Z",
        "13:20:00  ● stopped · last tick 13:17:15 · running 0 · today ■1 ✕1 □0 !0",
      ].join("\n") + "\n",
    );
    const { tui, terminal } = startTui();
    const events = terminal.screen.split("\n").slice(terminal.screen.split("\n").findIndex((l) => l.startsWith("── Events")) + 1, -1).map((l) => l.trimEnd()).filter((l) => l !== "");
    expect(events).toEqual([
      "            ● runner started · every 5m · herdr (claude)",
      "  13:07:15  ▶ x-autopost  launched in t6q",
      "  13:12:15  ■ x-autopost  succeeded in 15s       Nothing to post today",
      "  13:13:15  ✕ zancada     failed (exit 1) in 3s  boom",
      "  13:20:00  ○ runner stopped",
    ]);
    tui.stop();
  });

  test("retry asks first, then runs the command and shows its answer", async () => {
    writeFixture(home.paths);
    const { tui, terminal, calls } = startTui(async () => ({ code: 0, output: "▶ launched sentry-summary/…\n" }));
    terminal.type("r");
    expect(terminal.screen).toMatch(/Retry sentry-summary\/\S+\? .* \[y\/N\]/);
    terminal.type("n");
    expect(calls).toEqual([]);
    terminal.type("r");
    terminal.type("y");
    await flush();
    expect(calls).toEqual([{ args: ["retry", expect.stringMatching(/^sentry-summary\//)], interactive: false }]);
    expect(terminal.screen).toContain("▶ launched sentry-summary/…");
    tui.stop();
  });

  test("a run that can't be retried or attached says why", () => {
    writeFixture(home.paths);
    const { tui, terminal, calls } = startTui();
    terminal.type("j"); // a succeeded run
    terminal.type("r");
    expect(terminal.screen).toContain("only failed, timed-out or missed runs can be retried");
    terminal.type("a");
    expect(terminal.screen).toContain("only running or blocked runs have a session");
    expect(calls).toEqual([]);
    tui.stop();
  });

  test("p pauses an active task and resumes a paused one", async () => {
    writeFixture(home.paths);
    const { tui, terminal, calls } = startTui();
    terminal.type("\t\t"); // Recent → Running → Next
    terminal.type("p");
    terminal.type("G");
    terminal.type("p");
    await flush();
    expect(calls.map((c) => c.args)).toEqual([
      ["pause", "sentry-summary"],
      ["resume", "backup-notes"],
    ]);
    tui.stop();
  });

  test("attach hands the terminal over and takes it back", async () => {
    writeFixture(home.paths);
    const { tui, terminal, calls } = startTui();
    terminal.type("\t"); // Running
    terminal.type("a");
    expect(terminal.input).toBeNull(); // the command has the keyboard
    await flush();
    expect(calls).toEqual([{ args: ["attach", expect.stringMatching(/^review-pr-123\//)], interactive: true }]);
    expect(terminal.input).not.toBeNull();
    expect(terminal.out.lastIndexOf("\x1b[?1049h")).toBeGreaterThan(terminal.out.indexOf("\x1b[?1049l"));
    tui.stop();
  });

  test("? lists the keys of the view", () => {
    const { tui, terminal } = startTui();
    terminal.type("?");
    expect(terminal.screen).toContain("Keys (defaults");
    expect(terminal.screen).toMatch(/gg <Home>\s+first/);
    terminal.type("x");
    expect(terminal.screen).not.toContain("Keys (defaults");
    tui.stop();
  });
});

test("examples/tui.example.toml lists exactly the defaults", () => {
  const example = Bun.TOML.parse(readFileSync(join(import.meta.dir, "..", "examples", "tui.example.toml"), "utf8")) as { keys: Record<string, string[]> };
  expect(example.keys).toEqual(Object.fromEntries(Object.entries(DEFAULT_KEYS).map(([a, keys]) => [a, [...keys]])));
});

test("config check validates tui.toml when there is one", async () => {
  const check = async () => {
    let stdout = "";
    await main(["config", "check", "--json"], { env: home.env, cwd: home.root, stdout: { write: (t) => void (stdout += t) }, stderr: sink });
    return (JSON.parse(stdout).checks as { id: string; status: string; details?: string[] }[]).filter((c) => c.id === "config.tui");
  };
  expect(await check()).toEqual([]);
  writeFileSync(join(home.configDir, "tui.toml"), '[keys]\nretry = "<C-r>"\n');
  expect((await check()).map((c) => c.status)).toEqual(["ok"]);
  writeFileSync(join(home.configDir, "tui.toml"), '[keys]\nretry = "<Nope>"\n');
  const [failed] = await check();
  expect(failed!.status).toBe("error");
  expect(failed!.details![0]).toContain("unknown key <Nope>");
});
