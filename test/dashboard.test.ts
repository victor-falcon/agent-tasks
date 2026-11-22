import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { buildDashboard } from "../src/dashboard.ts";
import { exec } from "../src/launcher.ts";
import { runnerLogPath } from "../src/runner-lock.ts";
import { sanitize, wrap } from "../src/ui/text.ts";
import { parseLogLine } from "../src/ui/views/system/log-line.ts";
import { FIXTURE_NOW, FIXTURE_TZ, writeFixture } from "./fixtures/views.ts";
import { makeTempHome, type TempHome } from "./helpers.ts";

// The dashboard's data (`top --json`, which other UIs read), what `top`
// prints without a terminal, and `top` / `runner` opening the dashboard on a
// real terminal (tmux) and giving it back.

setDefaultTimeout(30_000);

const NOW = new Date(FIXTURE_NOW);

let home: TempHome;
beforeEach(() => {
  home = makeTempHome();
  home.writeConfig({ timezone: FIXTURE_TZ });
});
afterEach(() => home.cleanup());

const sink = { write: () => {} };
const context = (now = NOW) => createContext({ now, json: false, env: { ...home.env, NO_COLOR: "1" }, cwd: home.root, stdout: sink, stderr: sink, commands });

async function cli(args: string[], env: Record<string, string | undefined> = home.env): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, { env, cwd: home.root, stdout: { write: (t) => void (stdout += t) }, stderr: { write: (t) => void (stderr += t) } });
  return { code, stdout, stderr };
}

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

  test("top --json prints it once, in the shape other UIs read", async () => {
    writeFixture(home.paths);
    const { code, stdout } = await cli(["top", "--json", `--now=${FIXTURE_NOW}`]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout);
    expect(Object.keys(json)).toEqual(["schema", "now", "data_dir", "runner", "running", "next", "recent", "today", "events", "errors"]);
    expect(json.schema).toBe(1);
    expect(json.data_dir).toBe(home.paths.dataDir);
    expect(Object.keys(json.running[0])).toEqual(["ref", "task_id", "status", "slot", "attempt", "started_at", "finished_at", "at", "summary", "reason", "handle", "machine"]);
    expect(Object.keys(json.next[0])).toEqual(expect.arrayContaining(["task_id", "state", "at"]));
  });

  test("--next, the flag that opened this dashboard before it was the default, is still accepted", async () => {
    writeFixture(home.paths);
    const { code, stdout } = await cli(["top", "--next", "--json", `--now=${FIXTURE_NOW}`]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).schema).toBe(1);
  });
});

describe("top without a terminal", () => {
  test("prints what `status` prints and exits 0, even when something needs attention", async () => {
    writeFixture(home.paths);
    const env = { ...home.env, NO_COLOR: "1" };
    const top = await cli(["top", `--now=${FIXTURE_NOW}`], env);
    const status = await cli(["status", `--now=${FIXTURE_NOW}`], env);
    expect(status.code).toBe(1); // the fixture has a blocked run and failures
    expect(top.code).toBe(0);
    expect(top.stdout).toBe(status.stdout);
    expect(top.stdout).toContain("review-pr-123");
  });
});

describe("runner.log lines", () => {
  test("run events, task events and the runner's own lines", () => {
    expect(parseLogLine("13:07:15  tick  1 due · 1 running")).toBeNull();
    expect(parseLogLine("13:07:15  ⚠ demo                                 anomaly text")).toMatchObject({ task: "demo", what: "anomaly text" });
    expect(parseLogLine("13:07:15  ⚠ ~/x/y is not readable")).toMatchObject({ task: null, what: "~/x/y is not readable" });
    expect(parseLogLine("13:07:15  ⚠ took over a stale lock from pid 3")).toMatchObject({ task: null });
    expect(parseLogLine("13:07:15  ● degraded (see ⚠ above) · last tick 13:02:15 · running 0 · today ■0 ✕0 □0 !0")).toMatchObject({ what: "runner exited (degraded)" });
    expect(parseLogLine("13:07:15  ▶ a-very-long-task-id-that-fills-it/20261117T120700Z launched in t6q")).toMatchObject({ mark: "▶", task: "a-very-long-task-id-that-fills-it", what: "launched in t6q" });
  });
});

describe("captured text", () => {
  test("loses escapes and control characters", () => {
    expect(sanitize("\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 100%\n\tx\x07")).toBe("ok\nprogress 100%\n    x");
  });

  test("wraps between words, keeping a line's indentation", () => {
    expect(wrap("abcdef\nab", 4)).toEqual(["abcd", "ef", "ab"]);
    expect(wrap("hello big world of words", 10)).toEqual(["hello big", "world of", "words"]);
    expect(wrap("  - an indented bullet", 14)).toEqual(["  - an", "  indented", "  bullet"]);
  });
});

// A real terminal: tmux on a private socket, so the user's server is never touched.
const TMUX = Bun.which("tmux");

describe.skipIf(!TMUX)("on a terminal (tmux)", () => {
  const socket = `agent-tasks-dash-${crypto.randomUUID().slice(0, 8)}`;
  const tmux = (...args: string[]) => exec([TMUX!, "-L", socket, ...args], { env: { PATH: process.env.PATH } });
  const bin = join(import.meta.dir, "..", "bin", "agent-tasks");
  let pane = "";

  afterEach(() => void tmux("kill-server"));
  afterAll(() => void tmux("kill-server"));

  /** Starts `agent-tasks <args>` in a fresh 140x40 tmux session; `done` is written when it exits, with its exit code. */
  function start(args: string): void {
    const env = Object.entries({ ...home.env, TERM: "xterm-256color" })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}='${v}'`)
      .join(" ");
    const done = join(home.root, "done");
    const result = tmux("new-session", "-d", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}", `env ${env} ${process.execPath} ${bin} ${args}; echo $? > ${done}; sleep 30`);
    pane = result.stdout.trim();
  }

  const screen = () => tmux("capture-pane", "-p", "-t", pane).stdout;

  async function waitFor(what: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (what()) return;
      await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for ${label}; screen:\n${screen()}`);
  }

  /** The command's exit code once it has exited, else null. */
  const exitCode = () => {
    const text = existsSync(join(home.root, "done")) ? readFileSync(join(home.root, "done"), "utf8").trim() : "";
    return text === "" ? null : Number(text);
  };

  test("top opens the dashboard and q gives the terminal back", async () => {
    writeFixture(home.paths);
    start(`top --now=${FIXTURE_NOW}`);
    await waitFor(() => screen().includes("Needs attention"), "the Overview");
    expect(screen()).toContain("Overview");
    expect(screen()).toContain("review-pr-123");
    tmux("send-keys", "-t", pane, "q");
    await waitFor(() => exitCode() !== null, "top to exit");
    expect(exitCode()).toBe(0);
    expect(screen()).not.toContain("Needs attention"); // the alternate screen is gone
  });

  test("runner shows the dashboard while it ticks; q stops it and releases the lock", async () => {
    start("runner --every 1h");
    await waitFor(() => screen().includes("Overview"), "the dashboard");
    await waitFor(() => existsSync(join(home.paths.stateDir, "runner.lock")), "the runner's lock");
    tmux("send-keys", "-t", pane, "q");
    await waitFor(() => exitCode() !== null, "the runner to exit");
    expect(exitCode()).toBe(0);
    expect(existsSync(join(home.paths.stateDir, "runner.lock"))).toBe(false);
    expect(screen()).toContain("● healthy · last tick"); // the runner's final line, once the screen is back
  });
});
