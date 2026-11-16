import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../src/launcher.ts";
import { at, DEMO_REF, type ExecHome, execTask, makeExecHome, waitFor } from "./exec-helpers.ts";

// The tmux preset end to end: against a fake `tmux` (test/fixtures/fake-tmux.ts)
// that records its calls, and once against a real tmux on a private socket.

setDefaultTimeout(30_000);

const LOG = "runs/demo/20261117T080000Z.log";

describe("tmux preset (fake tmux)", () => {
  let home: ExecHome;
  beforeEach(() => {
    home = makeExecHome();
    home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "tmux" }, agent: { command: "clc" } });
  });
  afterEach(() => home.cleanup());

  const calls = (cmd: string) => home.fakeCalls("tmux").filter((c) => c[0] === cmd);
  const windowFile = (id: string) => join(home.fakeDir("tmux"), "windows", `${id.slice(1)}.json`);
  const window = (id: string) => JSON.parse(readFileSync(windowFile(id), "utf8"));
  const finish = (status: string) => home.cli("finish", DEMO_REF, "--status", status, "--summary", "done", "--now", at(10), "--json");

  test("outside tmux, launch opens a window in a dedicated agent-tasks session and types the agent command", async () => {
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: "@1" })]);

    expect(calls("has-session")).toEqual([["has-session", "-t", "=agent-tasks"]]);
    expect(calls("new-session")[0]!.slice(0, 11)).toEqual(["new-session", "-d", "-P", "-F", "#{window_id}", "-s", "agent-tasks", "-n", "task-demo-20261117t080000z", "-c", home.project]);
    expect(window("@1")).toMatchObject({
      session: "agent-tasks",
      name: "task-demo-20261117t080000z",
      cwd: home.project,
      argv: [
        "/usr/bin/env",
        `PATH=${home.env.PATH}`,
        `AGENT_TASKS_HOME=${home.dataDir}`,
        `AGENT_TASKS_CONFIG=${home.configFile}`,
        `AGENT_TASKS_RUN=${DEMO_REF}`,
        "AGENT_TASKS_ATTEMPT=1",
        "/bin/sh",
        "-i",
      ],
      keys: [` clc '/run-agent-task ${DEMO_REF}'; exit`, "<Enter>"],
    });
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ launcher: "tmux", handle: "@1", closed_at: null });
  });

  test("a second run goes into the existing agent-tasks session", async () => {
    execTask(home, "succeed");
    execTask(home, "succeed", { id: "other" });
    await home.tick(1);
    expect(calls("new-session")).toHaveLength(1);
    expect(calls("new-window")[0]!.slice(0, 7)).toEqual(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=agent-tasks:"]);
  });

  test("inside tmux, the window goes into the runner's session", async () => {
    home.env.TMUX = "/tmp/tmux-test/default,1,0";
    execTask(home, "succeed");
    await home.tick(1);
    expect(calls("display")).toEqual([["display", "-p", "#S"]]);
    expect(calls("new-window")[0]!.slice(5, 7)).toEqual(["-t", "main:"]);
    expect(calls("has-session")).toEqual([]);
  });

  test("status is working while the window lives; session read prints the pane", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    expect((await home.cli("session", "status", DEMO_REF, "--json")).json()).toMatchObject({ state: "working" });
    expect((await home.tick(5)).events).toEqual([]);
    expect(home.run(DEMO_REF).status).toBe("running");
    expect((await home.cli("session", "read", DEMO_REF)).stdout).toContain("screen of @1");
    expect(calls("capture-pane")).toEqual([["capture-pane", "-p", "-J", "-S", "-200", "-t", "@1"]]);
  });

  test("finish captures the pane into the log and kills the window", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    expect((await finish("succeeded")).json()).toMatchObject({ status: "succeeded", session: { closed_at: expect.any(String) } });
    expect(calls("kill-window")).toEqual([["kill-window", "-t", "@1"]]);
    expect(readFileSync(join(home.dataDir, LOG), "utf8")).toContain("screen of @1\n");
  });

  test("a window that closed without finish is failed / exited_without_report", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await home.cli("session", "close", DEMO_REF);
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
  });

  test("a dead pane (remain-on-exit) is exited: failed and its window killed", async () => {
    execTask(home, "succeed", { keep_open: "never" });
    await home.tick(1);
    writeFileSync(windowFile("@1"), JSON.stringify({ ...window("@1"), dead: true }));
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
    expect(calls("kill-window")).toEqual([["kill-window", "-t", "@1"]]);
  });

  test("on timeout the pane is captured, the window killed and the run timed_out", async () => {
    execTask(home, "succeed", { timeout: "30m" });
    await home.tick(1);
    expect((await home.tick(40)).events).toEqual([expect.objectContaining({ type: "timed_out" })]);
    expect(calls("capture-pane")).toHaveLength(1);
    expect(calls("kill-window")).toEqual([["kill-window", "-t", "@1"]]);
  });

  test("a command that could not be typed is failed / prompt_not_delivered", async () => {
    writeFileSync(join(home.fakeDir("tmux"), "fail-send-keys"), "");
    execTask(home, "succeed");
    expect((await home.tick(1)).events.map((e) => [e.type, e.reason ?? null])).toEqual([["launched", null], ["failed", "prompt_not_delivered"]]);
  });
});

// A real tmux server on a private socket. A `tmux` wrapper first on PATH adds
// `-L <socket>`, so the preset runs unchanged and never touches the user's server.
const TMUX = Bun.which("tmux");

describe.skipIf(!TMUX)("tmux preset (real tmux)", () => {
  const socket = `agent-tasks-test-${crypto.randomUUID().slice(0, 8)}`;
  const tmux = (...args: string[]) => exec([TMUX!, "-L", socket, ...args], { env: { PATH: process.env.PATH } });
  let home: ExecHome;

  beforeEach(() => {
    home = makeExecHome();
    const wrapperDir = join(home.root, "real-bin");
    mkdirSync(wrapperDir);
    writeFileSync(join(wrapperDir, "tmux"), `#!/bin/sh\nexec ${TMUX} -L ${socket} "$@"\n`, { mode: 0o755 });
    home.env.PATH = `${wrapperDir}:${home.env.PATH}`;
    // The agent prints its prompt and folder, then waits to be closed.
    home.writeConfig({
      timezone: "Europe/Madrid",
      launcher: { preset: "tmux" },
      agent: { command: "sh", args: ["-c", 'echo "started $0 in $(pwd -P)"; sleep 60'] },
    });
  });
  afterEach(() => home.cleanup());
  afterAll(() => {
    tmux("kill-server");
    // tmux leaves its socket file behind.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
  });

  test("launch, read and close a real window", async () => {
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    const handle = events[0]?.handle as string;
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: expect.stringMatching(/^@\d+$/) })]);
    expect(tmux("list-windows", "-t", "=agent-tasks", "-F", "#{window_id} #{window_name}").stdout.trim()).toBe(`${handle} task-demo-20261117t080000z`);

    const screen = await waitFor(() => {
      const out = tmux("capture-pane", "-p", "-J", "-t", handle).stdout;
      return out.includes("started /run-agent-task") && out;
    }, "the agent's output in the pane");
    expect(screen).toContain(`started /run-agent-task ${DEMO_REF} in ${realpathSync(home.project)}`);
    expect((await home.cli("session", "status", DEMO_REF, "--json")).json()).toMatchObject({ state: "working" });
    expect((await home.cli("session", "read", DEMO_REF)).stdout).toContain("started /run-agent-task");

    const finished = await home.cli("finish", DEMO_REF, "--status", "succeeded", "--summary", "done", "--now", at(5), "--json");
    expect(finished.json()).toMatchObject({ session: { closed_at: expect.any(String) } });
    expect(tmux("list-panes", "-t", handle).code).not.toBe(0);
    expect(readFileSync(join(home.dataDir, LOG), "utf8")).toContain("started /run-agent-task");
  });
});
