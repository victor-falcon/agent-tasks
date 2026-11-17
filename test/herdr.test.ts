import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { herdrSpaceId } from "../src/launcher.ts";
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
const appCallsFile = () => join(home.hcDir, "app-calls.jsonl");
const appCalls = (): string[][] => (existsSync(appCallsFile()) ? readFileSync(appCallsFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const spaces = () => JSON.parse(readFileSync(join(home.hcDir, "spaces.json"), "utf8")).spaces;
const labelsOf = (run: string[]) => run.slice(0, run.indexOf("--")).filter((_, i, flags) => flags[i - 1] === "--label");
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
      "AGENT_TASKS_ATTEMPT=1",
      "/bin/sh",
      "-i",
    ]);
    expect(calls("send")).toEqual([["send", "t2", ` clc '/run-agent-task ${DEMO_REF}'; exit`]]);
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ launcher: "herdr", handle: "t2", closed_at: null });
  });

  test("finish captures the screen into the log and closes the tab", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    const result = await finish("succeeded");
    expect(result.json()).toMatchObject({ status: "succeeded", session: { closed_at: expect.any(String) } });
    expect(calls("read")).toEqual([["read", "--lines", "200", "t2"]]);
    expect(calls("kill")).toEqual([["kill", "t2"]]);
    expect(readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8")).toBe("--- session output (2026-11-17T09:10:00+01:00) ---\nscreen of t2\n");
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
    expect(readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8")).toContain("---\nscreen of t2\n");
  });

  test("a status command that cannot run is an anomaly, not a failure", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "herdr", status: ["/nonexistent/hc", "get", "{{handle}}"] }, agent: { command: "clc" } });
    const { events } = await home.tick(2);
    expect(events).toEqual([expect.objectContaining({ type: "anomaly", message: expect.stringContaining("state is unknown") })]);
    expect(home.run(DEMO_REF).status).toBe("running");
  });

  test("a close that fails in tick is retried a few times and reported", async () => {
    execTask(home, "succeed", { keep_open: "never" });
    await home.tick(1);
    writeFileSync(join(home.hcDir, "fail-kill"), "");
    setTerminal("t2", { state: "finished" });
    const first = await home.tick(2);
    expect(first.events.map((e) => e.type)).toEqual(["failed", "anomaly"]);
    await home.tick(4);
    await home.tick(6);
    await home.tick(8);
    expect(calls("kill")).toHaveLength(3); // MAX_CLOSE_ATTEMPTS, then left to the user
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ closed_at: null, close_attempts: 3 });
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

  test("with $HC_TERMINAL_ID the space is left alone (no rename)", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    expect(appCalls()).toEqual([]);
  });
  test("a preset can be partly overridden", async () => {
    home.writeConfig({ launcher: { preset: "herdr", close: ["hc", "kill", "--force", "{{handle}}"] }, agent: { command: "clc" } });
    execTask(home, "succeed");
    await home.tick(1);
    await finish("succeeded");
    expect(calls("kill")).toEqual([["kill", "--force", "t2"]]);
  });
});

// A client machine (the hub launches over SSH) or a runner outside Herdr:
// no runner terminal, so runs open in a space of their own on this machine.
describe("herdr preset without $HC_TERMINAL_ID", () => {
  beforeEach(() => {
    delete home.env.HC_TERMINAL_ID;
  });
  const AGENT_TASKS = herdrSpaceId("Agent Tasks");

  test("opens the tab in a new \"Agent Tasks\" space, not nested, and names the space", async () => {
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: "t2" })]);
    expect(calls("get")).toEqual([]);
    const labels = labelsOf(calls("run")[0]!);
    expect(labels[0]).toBe(`herdr.space=${AGENT_TASKS}`);
    expect(labels[1]).toMatch(/^herdr\.tab=tb[0-9a-f]{32}$/);
    expect(labels.slice(2)).toEqual([`agent-tasks.run=${DEMO_REF}`]);
    expect(calls("send")).toHaveLength(1);
    expect(appCalls()).toEqual([["ls"], ["do", "space.rename", "--id", AGENT_TASKS, "--name", "Agent Tasks"]]);
    expect(spaces()).toEqual([{ id: AGENT_TASKS, name: "Agent Tasks", machine: null }]);
    expect(home.run(DEMO_REF).status).toBe("running");
  });

  test("reuses a space the window already shows with that name, without renaming it", async () => {
    writeFileSync(join(home.hcDir, "spaces.json"), JSON.stringify({ spaces: [{ id: "sp-other", name: "Agent Tasks", machine: "vps" }, { id: "sp-mine", name: "Agent Tasks", machine: null }] }));
    execTask(home, "succeed");
    await home.tick(1);
    expect(labelsOf(calls("run")[0]!)[0]).toBe("herdr.space=sp-mine");
    expect(appCalls()).toEqual([["ls"]]);
  });

  test("keeps the name the user gave the space an earlier run made", async () => {
    writeFileSync(join(home.hcDir, "spaces.json"), JSON.stringify({ spaces: [{ id: AGENT_TASKS, name: "Night shift", machine: null }] }));
    execTask(home, "succeed");
    await home.tick(1);
    expect(labelsOf(calls("run")[0]!)[0]).toBe(`herdr.space=${AGENT_TASKS}`);
    expect(appCalls()).toEqual([["ls"]]);
  });

  test("launcher.space picks another space", async () => {
    home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "herdr", space: "Night runs" }, agent: { command: "clc" } });
    execTask(home, "succeed");
    await home.tick(1);
    expect(labelsOf(calls("run")[0]!)[0]).toBe(`herdr.space=${herdrSpaceId("Night runs")}`);
    expect(spaces()).toEqual([{ id: herdrSpaceId("Night runs"), name: "Night runs", machine: null }]);
  });

  test("without the window the run still starts, in the space derived from the name", async () => {
    writeFileSync(join(home.hcDir, "app-down"), "");
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: "t2" })]);
    expect(labelsOf(calls("run")[0]!)[0]).toBe(`herdr.space=${AGENT_TASKS}`);
    expect(home.run(DEMO_REF).status).toBe("running");
    expect(appCalls()).toEqual([["ls"]]); // no rename retries without a window
  });

  test("status, read and close need no runner terminal", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    setTerminal("t2", { status: { state: "idle" } });
    expect((await home.cli("session", "read", DEMO_REF)).stdout).toContain("screen of t2");
    expect((await finish("succeeded")).code).toBe(0);
    expect(calls("kill")).toEqual([["kill", "t2"]]);
    expect(calls("get").every((c) => c[1] === "t2")).toBe(true);
  });
});
