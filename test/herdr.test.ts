import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, DEMO_REF, type ExecHome, execTask, makeExecHome } from "./exec-helpers.ts";

// The herdr preset end to end against a fake `hc` (test/fixtures/fake-hc.ts)
// that records its calls and serves `hc get --json` from files.

setDefaultTimeout(30_000);

let home: ExecHome;
beforeEach(() => {
  home = makeExecHome();
  home.env.HC_TERMINAL_ID = "t1";
  home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "herdr" }, agent: { command: "clc" } });
});
afterEach(() => home.cleanup());

const terminalFile = (t: string) => join(home.hcDir, "terminals", `${t}.json`);
function setTerminal(t: string, patch: Record<string, unknown>): void {
  const info = JSON.parse(readFileSync(terminalFile(t), "utf8"));
  writeFileSync(terminalFile(t), JSON.stringify({ ...info, ...patch }));
}
const calls = (sub: string) => home.hcCalls().filter((c) => c[0] === sub);
const finish = (status: string, minutes = 10) => home.cli("finish", DEMO_REF, "--status", status, "--summary", "done", "--now", at(minutes), "--json");

describe("herdr preset", () => {
  test("launch opens an interactive shell in a new tab under the runner and types the agent command", async () => {
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: "t2" })]);

    expect(calls("get")[0]).toEqual(["get", "t1", "--json"]);
    const run = calls("run")[0]!;
    const sep = run.indexOf("--");
    const flags = run.slice(0, sep);
    expect(flags.slice(0, 7)).toEqual(["run", "--bg", "--json", "--no-parent", "--no-notify", "--keep", "--name"]);
    expect(flags[7]).toBe("task-demo-20261117t080000z");
    expect(flags.slice(8, 10)).toEqual(["--cwd", home.project]);
    const labels = flags.filter((_, i) => flags[i - 1] === "--label");
    expect(labels[0]).toBe("herdr.space=sp-test");
    expect(labels[1]).toMatch(/^herdr\.tab=tb[0-9a-f]{32}$/);
    expect(labels.slice(2)).toEqual(["herdr.parent=t1", `agent-tasks.run=${DEMO_REF}`]);
    expect(run.slice(sep + 1)).toEqual([
      "/usr/bin/env",
      `PATH=${home.env.PATH}`,
      `AGENT_TASKS_HOME=${home.dataDir}`,
      `AGENT_TASKS_CONFIG=${home.configFile}`,
      `AGENT_TASKS_RUN=${DEMO_REF}`,
      "/bin/sh",
      "-i",
    ]);
    expect(calls("send")).toEqual([["send", "t2", ` clc '/run-agent-task ${DEMO_REF}'`]]);
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ launcher: "herdr", handle: "t2", closed_at: null });
  });

  test("finish captures the screen into the log and closes the tab", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    const result = await finish("succeeded");
    expect(result.json()).toMatchObject({ status: "succeeded", session: { closed_at: expect.any(String) } });
    expect(calls("read")).toEqual([["read", "--lines", "200", "t2"]]);
    expect(calls("kill")).toEqual([["kill", "t2"]]);
    expect(readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8")).toBe("screen of t2\n");
  });

  test("keep_open: always leaves the tab open", async () => {
    execTask(home, "succeed", { keep_open: "always" });
    await home.tick(1);
    await finish("succeeded");
    expect(calls("kill")).toEqual([]);
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ kept_open: true, closed_at: null });
    // Later ticks leave it alone too.
    await home.tick(15);
    expect(calls("kill")).toEqual([]);
  });

  test("a close that failed in finish is retried by a later tick", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    writeFileSync(join(home.hcDir, "fail-kill"), "");
    const result = await finish("succeeded");
    expect(result.json().session).toMatchObject({ closed_at: null, close_error: expect.stringContaining("close failed") });

    rmSync(join(home.hcDir, "fail-kill"));
    expect((await home.tick(10)).events.map((e) => e.type)).toEqual(["succeeded"]); // within the grace period: not closed yet
    expect(calls("kill")).toHaveLength(1);
    await home.tick(12);
    expect(calls("kill")).toHaveLength(2);
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ closed_at: expect.any(String), close_error: null });
  });

  test("status blocked marks the run blocked, and working again unblocks it", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    setTerminal("t2", { status: { app: "claude", state: "blocked" } });
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "blocked", run_ref: DEMO_REF })]);
    expect(home.run(DEMO_REF).status).toBe("blocked");
    expect((await home.tick(3)).events).toEqual([]); // reported once

    setTerminal("t2", { status: { app: "claude", state: "working" } });
    await home.tick(4);
    expect(home.run(DEMO_REF).status).toBe("running");
  });

  test("a terminal that finished without finish is failed / exited_without_report and closed", async () => {
    execTask(home, "succeed", { keep_open: "never" });
    await home.tick(1);
    setTerminal("t2", { state: "finished", exit_code: 0 });
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
    expect(calls("kill")).toEqual([["kill", "t2"]]);
  });

  test("a terminal that disappeared is failed / exited_without_report", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await home.cli("session", "close", DEMO_REF);
    // `session close` only closes; the next tick finds the run's session gone.
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
  });

  test("on timeout the screen is captured, the tab closed and the run timed_out", async () => {
    execTask(home, "succeed", { timeout: "30m", keep_open: "always" });
    await home.tick(1);
    expect((await home.tick(40)).events).toEqual([expect.objectContaining({ type: "timed_out" })]);
    expect(calls("read")).toHaveLength(1);
    expect(calls("kill")).toEqual([["kill", "t2"]]); // timeouts close even with keep_open: always
    expect(readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8")).toBe("screen of t2\n");
  });

  test("a prompt that could not be typed is failed / prompt_not_delivered", async () => {
    writeFileSync(join(home.hcDir, "fail-send"), "");
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events.map((e) => [e.type, e.reason ?? null])).toEqual([["launched", null], ["failed", "prompt_not_delivered"]]);
    const run = home.run(DEMO_REF);
    expect(run).toMatchObject({ status: "failed", reason: "prompt_not_delivered" });
    expect(run.attempts[0]!.session).toMatchObject({ kept_open: true }); // keep_open: on_failure
  });

  test("without $HC_TERMINAL_ID the launch fails with a clear reason", async () => {
    delete home.env.HC_TERMINAL_ID;
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "failed", reason: "launch_failed", message: expect.stringContaining("$HC_TERMINAL_ID is not set") })]);
    expect(calls("run")).toEqual([]);
  });

  test("a preset can be partly overridden", async () => {
    home.writeConfig({ launcher: { preset: "herdr", close: ["hc", "kill", "--force", "{{handle}}"] }, agent: { command: "clc" } });
    execTask(home, "succeed");
    await home.tick(1);
    await finish("succeeded");
    expect(calls("kill")).toEqual([["kill", "--force", "t2"]]);
  });
});
